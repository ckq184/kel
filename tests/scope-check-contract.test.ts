import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import {
  DECLARATION_FILE,
  auditScope,
  collectChangedPaths,
  validateDeclaration,
} from '../scripts/check-scope.mjs';
import { removeTmpDirRecursive } from './helpers/remove-tmp-dir';

const repoRoot = process.cwd();
const checkScopeScript = path.join(repoRoot, 'scripts', 'check-scope.mjs');

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) removeTmpDirRecursive(dir);
});

function makeTmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-check-contract-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function gitCommit(repo: string, message: string): void {
  execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=contract',
      '-c',
      'user.email=contract@test.local',
      'commit',
      '-m',
      message,
    ],
    { cwd: repo, stdio: 'ignore' },
  );
}

function runCli(repo: string) {
  return spawnSync(process.execPath, [checkScopeScript], {
    cwd: repo,
    encoding: 'utf8',
  });
}

describe('范围声明校验（.gatescope.json）', () => {
  test('合法声明解析出 task/base/allow', () => {
    const declaration = validateDeclaration(
      JSON.stringify({
        task: '任务X - 某事',
        base: 'abc1234',
        allow: ['scripts/**', 'docs/task-x-*.md'],
      }),
    );
    expect(declaration.task).toBe('任务X - 某事');
    expect(declaration.base).toBe('abc1234');
    expect(declaration.allow).toEqual(['scripts/**', 'docs/task-x-*.md']);
  });

  test('缺字段 / 非法 JSON / allow 非数组 / 空声明均拒绝', () => {
    expect(() => validateDeclaration('not-json')).toThrow();
    expect(() => validateDeclaration('{}')).toThrow();
    expect(() =>
      validateDeclaration(JSON.stringify({ task: 't', base: 'b' })),
    ).toThrow();
    expect(() =>
      validateDeclaration(
        JSON.stringify({ task: 't', base: 'b', allow: 'scripts/' }),
      ),
    ).toThrow();
    expect(() =>
      validateDeclaration(JSON.stringify({ task: 't', base: '', allow: [] })),
    ).toThrow();
  });

  test('声明文件常量与仓库根文件名一致', () => {
    expect(DECLARATION_FILE).toBe('.gatescope.json');
  });
});

describe('auditScope：路径归类与声明变更审计', () => {
  const compiled = [
    'scripts/*.mjs',
    'tests/**',
    'docs/*.md',
    '.gatescope.json',
  ];

  test('范围内/范围外路径正确归类；声明文件自允许并触发审计标记', () => {
    const audit = auditScope(
      [
        'scripts/a.mjs',
        'tests/x/y.test.ts',
        'docs/t.md',
        'src/index.ts',
        '.gatescope.json',
      ],
      compiled,
    );
    expect(audit.inScope.map((item) => item.path)).toEqual([
      'scripts/a.mjs',
      'tests/x/y.test.ts',
      'docs/t.md',
      '.gatescope.json',
    ]);
    expect(audit.outOfScope.map((item) => item.path)).toEqual(['src/index.ts']);
    expect(audit.declarationChanged).toBe(true);
  });

  test('无声明文件变更时 declarationChanged 为 false', () => {
    const audit = auditScope(['scripts/a.mjs'], compiled, []);
    expect(audit.declarationChanged).toBe(false);
    expect(audit.outOfScope).toHaveLength(0);
  });

  test('删除与新增路径同样按声明归类（不区分变更类型）', () => {
    const audit = auditScope(
      ['old/deleted.ts', 'new-file.ts'],
      ['new-file.ts'],
    );
    expect(audit.outOfScope.map((item) => item.path)).toEqual([
      'old/deleted.ts',
    ]);
  });
});

describe('collectChangedPaths：base→工作树全量采集', () => {
  test('含已改、已暂存新文件与未跟踪文件；不含 gitignored', () => {
    const repo = makeTmpRepo();
    fs.writeFileSync(path.join(repo, 'keep.ts'), 'a\n');
    fs.writeFileSync(path.join(repo, 'stale.ts'), 'a\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored-dir/\n');
    gitCommit(repo, 'init');
    fs.writeFileSync(path.join(repo, 'keep.ts'), 'b\n'); // 已修改（未暂存）
    fs.writeFileSync(path.join(repo, 'added.ts'), 'x\n');
    execFileSync('git', ['add', 'added.ts'], { cwd: repo, stdio: 'ignore' }); // 已暂存新文件
    fs.writeFileSync(path.join(repo, 'untracked.ts'), 'x\n'); // 未跟踪
    fs.mkdirSync(path.join(repo, 'ignored-dir'));
    fs.writeFileSync(path.join(repo, 'ignored-dir', 'j.ts'), 'x\n'); // gitignored
    const base = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    const changed = collectChangedPaths(repo, base);
    expect(changed.sort()).toEqual(['added.ts', 'keep.ts', 'untracked.ts']);
  });

  // ISSUE-21 C4：锁定 ISSUE-15 的 `-c core.quotepath=false`。仓库显式开启
  // quotepath 时，git 默认把非 ASCII 路径八进制转义加引号；脚本必须仍返回
  // 原文路径，否则 allow 里的中文路径永远命中不了。
  test('非 ASCII（中文）路径按原文采集，不受仓库 quotepath 配置影响', () => {
    const repo = makeTmpRepo();
    execFileSync('git', ['config', 'core.quotepath', 'true'], {
      cwd: repo,
      stdio: 'ignore',
    });
    fs.mkdirSync(path.join(repo, 'docs'));
    fs.writeFileSync(path.join(repo, 'docs', '审查记录.md'), 'a\n');
    gitCommit(repo, 'init');
    const base = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    fs.writeFileSync(path.join(repo, 'docs', '审查记录.md'), 'b\n'); // 已修改
    fs.mkdirSync(path.join(repo, '中文目录'));
    fs.writeFileSync(path.join(repo, '中文目录', '新文件.ts'), 'x\n'); // 未跟踪

    expect(collectChangedPaths(repo, base).sort()).toEqual(
      ['docs/审查记录.md', '中文目录/新文件.ts'].sort(),
    );
    const audit = auditScope(collectChangedPaths(repo, base), [
      'docs/审查记录.md',
    ]);
    expect(audit.inScope.map((item) => item.path)).toEqual([
      'docs/审查记录.md',
    ]);
    expect(audit.outOfScope.map((item) => item.path)).toEqual([
      '中文目录/新文件.ts',
    ]);
  });
});

// 与 githooks-contract 安装器用例同构：git init + 两次 CLI 子进程，全量
// 负载下 Windows spawn 变慢会超默认 5s（任务 L 批次 3 收官轮实测翻红、
// 单跑绿——任务 K §8 边缘预算现象），显式放宽到 30s。
describe('check-scope CLI（temp 仓库端到端）', () => {
  test('范围外变更被拦（exit 1，列出文件与处置指引）；合规后通过（exit 0）', () => {
    const repo = makeTmpRepo();
    fs.writeFileSync(path.join(repo, 'base.txt'), 'a\n');
    gitCommit(repo, 'init');
    const base = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    fs.writeFileSync(
      path.join(repo, '.gatescope.json'),
      JSON.stringify({ task: '任务T', base, allow: ['in-scope/*'] }, null, 2),
    );
    fs.mkdirSync(path.join(repo, 'in-scope'));
    fs.writeFileSync(path.join(repo, 'in-scope', 'a.ts'), 'x\n'); // 范围内
    fs.writeFileSync(path.join(repo, 'outside.ts'), 'x\n'); // 范围外

    const blocked = runCli(repo);
    expect(blocked.status).toBe(1);
    const blockedOut = `${blocked.stdout}${blocked.stderr}`;
    expect(blockedOut).toContain('outside.ts');
    expect(blockedOut).toContain('.gatescope.json'); // 首个声明 → 审计提示
    expect(blockedOut).toContain('in-scope'); // 允许清单回显

    fs.rmSync(path.join(repo, 'outside.ts'));
    const pass = runCli(repo);
    expect(pass.status).toBe(0);
    expect(pass.stdout).toContain('2 个路径');
  }, 30_000);

  test('base 引用不可解析按用法错误退出（exit 2）', () => {
    const repo = makeTmpRepo();
    fs.writeFileSync(
      path.join(repo, '.gatescope.json'),
      JSON.stringify({ task: 't', base: 'no-such-ref', allow: ['**'] }),
    );
    expect(runCli(repo).status).toBe(2);
  });

  test('缺声明文件按用法错误退出并给出创建指引（exit 2）', () => {
    const repo = makeTmpRepo();
    const missing = runCli(repo);
    expect(missing.status).toBe(2);
    expect(`${missing.stdout}${missing.stderr}`).toContain('.gatescope.json');
  });
});

describe('任务L dogfood：本仓库声明与全量 diff', () => {
  test('本仓库带 .gatescope.json（base=任务L立项提交）', () => {
    const declaration = JSON.parse(
      fs.readFileSync(path.join(repoRoot, '.gatescope.json'), 'utf8'),
    );
    expect(declaration.base).toMatch(/^[0-9a-f]{7,40}$/);
    // 只断言非空：allow 条数随任务范围宽窄而定（任务P 窄范围仅 4 条，
    // 任务L 时代的 >5 阈值与最小范围纪律冲突）。
    expect(declaration.allow.length).toBeGreaterThan(0);
    expect(
      execFileSync(
        'git',
        ['rev-parse', '--verify', `${declaration.base}^{commit}`],
        { cwd: repoRoot, encoding: 'utf8' },
      ).trim(),
    ).toBe(
      execFileSync('git', ['rev-parse', declaration.base], {
        cwd: repoRoot,
        encoding: 'utf8',
      }).trim(),
    );
  });
});
