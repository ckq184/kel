import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const write = process.argv.includes('--write');
const supportedExtensions = new Set([
  '.css',
  '.html',
  '.js',
  '.jsx',
  '.json',
  '.md',
  '.mjs',
  '.scss',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);

function git(args, allowFailure = false) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', allowFailure ? 'ignore' : 'inherit'],
    }).trim();
  } catch (error) {
    if (allowFailure) return '';
    throw error;
  }
}

function addLines(target, value) {
  for (const line of value.split('\n')) {
    if (line) target.add(line);
  }
}

const files = new Set();
let base = process.env.FORMAT_BASE_REF?.trim();
if (base && !git(['rev-parse', '--verify', `${base}^{commit}`], true)) {
  base = undefined;
}
if (!base && git(['rev-parse', '--verify', 'origin/main^{commit}'], true)) {
  base = 'origin/main';
}
if (!base && git(['rev-parse', '--verify', 'HEAD^'], true)) base = 'HEAD^';

if (base) {
  const mergeBase = git(['merge-base', base, 'HEAD'], true) || base;
  addLines(
    files,
    git(['diff', '--name-only', '--diff-filter=ACMR', `${mergeBase}...HEAD`]),
  );
}
addLines(files, git(['diff', '--name-only', '--diff-filter=ACMR']));
addLines(files, git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']));
addLines(files, git(['ls-files', '--others', '--exclude-standard']));

const candidates = [...files]
  .filter((file) => supportedExtensions.has(path.extname(file).toLowerCase()))
  .filter((file) => fs.existsSync(path.join(root, file)))
  .sort();

if (candidates.length === 0) {
  console.log('No changed files require Prettier checks.');
  process.exit(0);
}

const prettierCjs = path.join(
  root,
  'node_modules',
  'prettier',
  'bin',
  'prettier.cjs',
);
// 分批传递：Windows 命令行长度有限，base 探测到远端 merge-base 落在
// 历史根部时候选集可达全仓库（2026-10-24 首次推送前的 fetch 窗口期
// 实测 880+ 文件 ENAMETOOLONG），逐批 spawn 结果等价。
const BATCH_SIZE = 64;
for (let start = 0; start < candidates.length; start += BATCH_SIZE) {
  const batch = candidates.slice(start, start + BATCH_SIZE);
  const result = spawnSync(
    process.execPath,
    [prettierCjs, write ? '--write' : '--check', ...batch],
    {
      cwd: root,
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}
process.exit(0);
