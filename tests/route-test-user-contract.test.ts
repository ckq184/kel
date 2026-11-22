import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

/**
 * ISSUE-12 波 7 单元 7.3 防回潮契约（仿 ISSUE-11 no-duplicate-helpers）：
 * 路由测试用户 helper 已收敛 tests/helpers/route-test-user.ts——全仓测试
 * 不得再内联 function asUser / createUser / seedUser 定义；新增变体必须进
 * helper（如 env 键集不同，具名导出新变体，而非回到各文件复制）。
 */

const repoRoot = process.cwd();

function listTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'helpers') continue;
      out.push(...listTestFiles(p));
      continue;
    }
    if (entry.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('route-test user helper centralization contract', () => {
  test('no test file redefines the converged user helpers', () => {
    const offenders: string[] = [];
    const patterns = [
      /^function asUser\(/,
      /^function createUser\(/,
      /^function seedUser\(/,
    ];
    for (const file of listTestFiles(path.join(repoRoot, 'tests'))) {
      const source = fs.readFileSync(file, 'utf8');
      for (const line of source.split('\n')) {
        const bare = line.replace(/\r$/, '');
        if (patterns.some((re) => re.test(bare))) {
          offenders.push(`${path.relative(repoRoot, file)}: ${bare.trim()}`);
        }
      }
    }
    expect(
      offenders,
      '路由测试用户 helper 必须经 tests/helpers/route-test-user.ts 具名导出；' +
        '如需新变体（不同 env 键集），请在 helper 中新增具名导出，不要回潮内联定义。' +
        `发现内联定义：${offenders.join(' | ')}`,
    ).toEqual([]);
  });

  test('the shared helper exports all five named variants', () => {
    const helper = fs.readFileSync(
      path.join(repoRoot, 'tests/helpers/route-test-user.ts'),
      'utf8',
    );
    for (const name of [
      'asRouteTestUser',
      'asOwnerProfileRouteUser',
      'asSystemSettingsTestUser',
      'asInteractionTestUser',
      'asMemoryRouteTestUser',
      'createTestUserRow',
    ]) {
      expect(helper).toMatch(new RegExp(`export function ${name}\\(`));
    }
  });
});
