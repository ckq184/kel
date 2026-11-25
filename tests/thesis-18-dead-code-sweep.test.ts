/**
 * THESIS-18 死代码清扫：源码契约。
 *
 * 验收锚点（计划 §2.1）：
 * 1. S1/S2：`OAuthUsageBucket`、`OAuthUsageResponse`、`CachedOAuthUsage`、
 *    `parseOAuthUsageBucket` 在 `src/`、`container/`、`scripts/` 零出现；
 * 2. S3：`resolveProfileToConfig` 在 `src/`、`container/`、`scripts/` 零出现；
 *    唯一调用方消失后的孤儿 `buildOfficialClaudeProviderConfig` 按非目标保留；
 * 3. S4：`generateInviteCode` 在 `src/`、`container/`、`scripts/` 零出现；
 * 4. S5：`src/db.ts` 的四个空分节注释零出现，schema 版本不动；
 * 5. S6：`PiProviderResolution` 不再有 `custom` 字段与 `custom: true` 返回，
 *    `pi-runtime.ts` 无条件挂载子 Agent 继承扩展；
 * 6. S7：冒烟脚本不再读取两个 OAuth 凭证字段，仍以
 *    `anthropicApiKey || anthropicAuthToken` 判定 providerConfigured。
 *
 * 纯删除与等价改写，运行行为由既有 THESIS-04/22 行为用例兜底。
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const read = (relative: string) =>
  fs.readFileSync(path.join(root, relative), 'utf8');

const PRODUCTION_DIRS = ['src', 'container/agent-runner/src', 'scripts'];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, dir), {
    withFileTypes: true,
  })) {
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(path.posix.join(dir, entry.name)));
    } else if (entry.name.endsWith('.ts')) {
      out.push(path.posix.join(dir, entry.name));
    }
  }
  return out;
}

const PRODUCTION_FILES = PRODUCTION_DIRS.flatMap(listSourceFiles);

function filesMatching(pattern: RegExp): string[] {
  return PRODUCTION_FILES.filter((file) => pattern.test(read(file)));
}

describe('THESIS-18 S1/S2: OAuth 用量死导出', () => {
  test('三个类型与 parseOAuthUsageBucket 在 src/container/scripts 零出现', () => {
    for (const symbol of [
      'OAuthUsageBucket',
      'OAuthUsageResponse',
      'CachedOAuthUsage',
      'parseOAuthUsageBucket',
    ]) {
      expect(filesMatching(new RegExp(`\\b${symbol}\\b`)), symbol).toEqual([]);
    }
    // S2 同时删除分节标题；ISSUE-11 注释随符号断言一并消失。
    expect(read('src/runtime-config.ts')).not.toContain('OAuth Usage Types');
  });
});

describe('THESIS-18 S3: resolveProfileToConfig', () => {
  test('无调用方函数删除，孤儿 helper 按非目标保留', () => {
    expect(filesMatching(/\bresolveProfileToConfig\b/)).toEqual([]);
    // 非目标：不做清单外清理，S3 产生的孤儿只登记不删。
    expect(read('src/runtime-config.ts')).toMatch(
      /function buildOfficialClaudeProviderConfig\(/,
    );
  });
});

describe('THESIS-18 S4: generateInviteCode', () => {
  test('邀请码下线后的死导出在 src/container/scripts 零出现', () => {
    expect(filesMatching(/\bgenerateInviteCode\b/)).toEqual([]);
  });
});

describe('THESIS-18 S5: db.ts 空分节注释', () => {
  test('四个空分节注释删除，相邻代码守卫保留', () => {
    const source = read('src/db.ts');
    for (const title of [
      'User Subscriptions',
      'User Balances',
      'Monthly Usage',
      'Redeem Codes',
    ]) {
      expect(source, title).not.toContain(`// --- ${title} ---`);
    }
    // 非目标：只删注释；schema 版本由 tests/db-upgrade-safety.test.ts 的版本钉锁定。
    expect(source).toContain('export function deleteMessage(');
    expect(source).toContain('export function closeDatabase(');
  });
});

describe('THESIS-18 S6: PiProviderResolution 不再有 custom', () => {
  const providerSource = read(
    'container/agent-runner/src/runtime/pi/pi-provider.ts',
  );
  const runtimeSource = read(
    'container/agent-runner/src/runtime/pi/pi-runtime.ts',
  );

  test('类型与返回对象都不再带 custom 字段', () => {
    const typeStart = providerSource.indexOf(
      'export type PiProviderResolution = {',
    );
    expect(typeStart).toBeGreaterThan(-1);
    const typeEnd = providerSource.indexOf('};', typeStart);
    expect(typeEnd).toBeGreaterThan(typeStart);
    expect(providerSource.slice(typeStart, typeEnd)).not.toMatch(/\bcustom\b/);
    expect(providerSource).not.toMatch(/\bcustom\s*:\s*true\b/);
  });

  test('工厂数组无条件挂载子 Agent 继承扩展', () => {
    expect(runtimeSource).not.toMatch(/modelResolution\.custom/);
    const marker = 'const extensionFactories = () => [';
    const start = runtimeSource.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const end = runtimeSource.indexOf('];', start);
    expect(end).toBeGreaterThan(start);
    const factories = runtimeSource.slice(start, end);
    expect(factories).toContain('createCkqclawMcpExtension()');
    expect(factories).toContain('createSubagentInheritModelExtension()');
    // 无条件：没有 custom 条件，也没有展开语法。
    expect(factories).not.toContain('modelResolution');
    expect(factories).not.toContain('...');
  });
});

describe('THESIS-18 S7: 冒烟脚本不再读取 OAuth 凭证', () => {
  const source = read('scripts/test-real-model-smoke.ts');

  test('providerConfigured 只看 apiKey / authToken，Base URL 独立', () => {
    expect(source).not.toMatch(
      /\b(claudeCodeOauthToken|claudeOAuthCredentials)\b/,
    );
    expect(source).toMatch(/config\.anthropicApiKey\s*\|\|/);
    expect(source).toContain('config.anthropicAuthToken');
    expect(source).toContain(
      'baseUrlPresent: Boolean(config.anthropicBaseUrl)',
    );
  });
});
