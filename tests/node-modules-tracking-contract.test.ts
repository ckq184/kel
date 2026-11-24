import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { removeTmpDirRecursive } from './helpers/remove-tmp-dir';

// 17113e9 的教训：合并工作树里的 node_modules 符号链接被 `git add -A`
// 带进索引，新 worktree 一跑 npm ci 就把链接换成实体目录，check-scope 的
// base→工作树 diff 因此多出三条越界路径。这里锁两件事：
//   1. 仓库索引里不允许出现任何 node_modules 路径段；
//   2. 忽略规则必须覆盖目录之外的形态（普通文件、符号链接），否则
//      `node_modules/` 的尾斜杠会让链接再次被暂存。

const repoRoot = process.cwd();
const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) removeTmpDirRecursive(dir);
});

function makeTmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-modules-tracking-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  fs.copyFileSync(
    path.join(repoRoot, '.gitignore'),
    path.join(dir, '.gitignore'),
  );
  return dir;
}

function trackedPaths(repo: string): string[] {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: repo,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
}

describe('node_modules 不进入版本库（17113e9 教训）', () => {
  test('本仓库索引无任何 node_modules 路径段', () => {
    const tracked = trackedPaths(repoRoot).filter((file) =>
      file.split('/').includes('node_modules'),
    );
    expect(tracked).toEqual([]);
  });

  test('忽略规则覆盖 node_modules 目录、普通文件与符号链接', () => {
    const dir = makeTmpRepo();

    // 目录形态：npm ci 的正常产物。
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(
      path.join(dir, 'node_modules', 'installed-dep.js'),
      'module.exports = 1;\n',
    );

    // 文件形态：尾斜杠规则最容易漏掉的一类（git 只按目录匹配）。
    fs.mkdirSync(path.join(dir, 'file-probe'));
    fs.writeFileSync(path.join(dir, 'file-probe', 'node_modules'), '\n');

    // 符号链接形态：worktree 共用主仓依赖时的本地做法，也是 17113e9
    // 被误提交的形态。Windows 无开发者模式时创建链接可能失败，此时
    // 前两种形态仍能锁住尾斜杠缺口。
    fs.mkdirSync(path.join(dir, 'symlink-probe'));
    try {
      fs.symlinkSync('.', path.join(dir, 'symlink-probe', 'node_modules'));
    } catch (error) {
      if (process.platform !== 'win32') throw error;
    }

    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
    expect(trackedPaths(dir)).toEqual(['.gitignore']);
  });
});
