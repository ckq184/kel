/**
 * THESIS-02：bug-report 的"模型可用"判断从"只认官方凭据"改写为第三方判定。
 *
 * 存量缺陷：原实现只看 anthropicApiKey / claudeCodeOauthToken /
 * claudeOAuthCredentials，只配了第三方的用户被判为不可用。本用例锁定：
 * - Base URL + Auth Token、Base URL + API Key 都算可用；
 * - 只有官方字段、没有 Base URL 不算可用。
 *
 * checkCapabilities 有 5 分钟模块级缓存，因此每个夹具都重新装载模块。
 */
import { describe, expect, test, vi } from 'vitest';

type ProviderConfig = Record<string, unknown> | null;

async function capabilitiesWith(
  config: ProviderConfig,
): Promise<{ claudeAvailable: boolean }> {
  vi.resetModules();
  vi.doMock('../src/runtime-config.js', () => ({
    getClaudeProviderConfig: () => config,
  }));
  vi.doMock('../src/middleware/auth.js', () => ({
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: 'thesis-02-admin',
        username: 'thesis-02-admin',
        role: 'admin',
        status: 'active',
        must_change_password: false,
      });
      return next();
    },
  }));
  vi.doMock('../src/db.js', () => ({
    getUserHomeGroup: () => null,
  }));
  vi.doMock('../src/sdk-query.js', () => ({
    sdkQuery: vi.fn(),
  }));
  vi.doMock('../src/config.js', () => ({
    DATA_DIR: '/tmp/ckqclaw-thesis-02-bug-report',
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));
  // gh 检测只影响 ghAvailable，本用例只关心 claudeAvailable。
  vi.doMock('child_process', () => ({
    execFile: (_cmd: string, _args: string[], _opts: unknown, cb: Function) =>
      cb(new Error('gh unavailable')),
  }));

  const { default: bugReportRoutes } =
    await import('../src/routes/bug-report.js');
  const response = await bugReportRoutes.request('/capabilities');
  expect(response.status).toBe(200);
  return (await response.json()) as { claudeAvailable: boolean };
}

describe('bug-report claude availability uses the third-party predicate', () => {
  test('base URL + Auth Token is available', async () => {
    await expect(
      capabilitiesWith({
        anthropicBaseUrl: 'https://gateway.example.test',
        anthropicAuthToken: 'gateway-token',
      }),
    ).resolves.toMatchObject({ claudeAvailable: true });
  });

  test('base URL + API Key is available', async () => {
    await expect(
      capabilitiesWith({
        anthropicBaseUrl: 'https://gateway.example.test',
        anthropicApiKey: 'sk-third-party',
      }),
    ).resolves.toMatchObject({ claudeAvailable: true });
  });

  test('official-only credentials without base URL are unavailable', async () => {
    await expect(
      capabilitiesWith({
        anthropicApiKey: 'sk-official',
        claudeCodeOauthToken: 'legacy-oauth-token',
        claudeOAuthCredentials: { accessToken: 'legacy' },
      }),
    ).resolves.toMatchObject({ claudeAvailable: false });
  });

  test('empty configuration is unavailable', async () => {
    await expect(capabilitiesWith({})).resolves.toMatchObject({
      claudeAvailable: false,
    });
  });
});
