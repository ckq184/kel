import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

/**
 * THESIS-05 凭据链清理契约。
 *
 * 背景：THESIS-02 已删除官方 OAuth 路由与凭据刷新调用方，官方凭据的写入、
 * 会话刷新与 `.credentials.json` 生成只剩死代码。本包按方案 §5 T4 删除这条
 * 链路（审核更正 S2：第三方分支里的 oauthAccount 剥离与残留凭据清理保留），
 * 并按 D-3 ① 摘掉工作区"容器环境变量"里的官方令牌字段。
 *
 * 行为用例覆盖可单测的纯函数与容器模式的工作区准备（buildVolumeMounts）；
 * 主机模式写入依赖子进程，由源码契约兜底。
 */

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'thesis-05-credential-chain-'),
);

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const runtimeConfig = await import('../src/runtime-config.js');
const db = await import('../src/db.js');
const { ContainerEnvSchema } = await import('../src/schemas.js');
const { buildVolumeMounts } = await import('../src/container-runner.js');

const configFile = path.join(root, 'config', 'claude-provider.json');
const repoRoot = path.resolve(import.meta.dirname, '..');
const readSource = (relative: string) =>
  fs.readFileSync(path.join(repoRoot, relative), 'utf8');

const FAKE_HOME = path.join(root, 'fake-home');
const previousHome = process.env.HOME;

beforeAll(() => {
  fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  fs.mkdirSync(path.join(root, 'groups'), { recursive: true });
  fs.mkdirSync(FAKE_HOME, { recursive: true });
  // 容器模式会读取 os.homedir()/.claude.json；统一指向临时目录，避免依赖
  // 开发者真实家目录，也避免把真实配置复制进临时目录。
  process.env.HOME = FAKE_HOME;
  db.initDatabase();
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

function providerConfig(
  patch: Partial<Parameters<typeof runtimeConfig.buildClaudeEnvLines>[0]> = {},
): Parameters<typeof runtimeConfig.buildClaudeEnvLines>[0] {
  return {
    anthropicBaseUrl: '',
    anthropicAuthToken: '',
    anthropicApiKey: '',
    claudeCodeOauthToken: '',
    claudeOAuthCredentials: null,
    anthropicModel: 'test-model',
    updatedAt: null,
    ...patch,
  };
}

const NO_CUSTOM_ENV: Record<string, string> = {};

describe('凭据链：官方 OAuth 环境变量映射已下线', () => {
  test('单 token 官方配置不再注入 CLAUDE_CODE_OAUTH_TOKEN 或 ANTHROPIC_AUTH_TOKEN', () => {
    const lines = runtimeConfig.buildClaudeEnvLines(
      providerConfig({ claudeCodeOauthToken: 'fake-oauth-token' }),
      NO_CUSTOM_ENV,
    );

    expect(
      lines.some((line) => line.startsWith('CLAUDE_CODE_OAUTH_TOKEN=')),
    ).toBe(false);
    expect(lines.some((line) => line.startsWith('ANTHROPIC_AUTH_TOKEN='))).toBe(
      false,
    );
  });

  test('完整 OAuth 凭据不再映射 access token', () => {
    const lines = runtimeConfig.buildClaudeEnvLines(
      providerConfig({
        claudeOAuthCredentials: {
          accessToken: 'fake-access-token',
          refreshToken: 'fake-refresh-token',
          expiresAt: 4102444800000,
          scopes: ['user:inference'],
        },
      }),
      NO_CUSTOM_ENV,
    );

    expect(lines.some((line) => line.startsWith('ANTHROPIC_AUTH_TOKEN='))).toBe(
      false,
    );
  });

  test('第三方 Base URL + Auth Token 的注入保持不变', () => {
    const lines = runtimeConfig.buildClaudeEnvLines(
      providerConfig({
        anthropicBaseUrl: 'https://gateway.example.test',
        anthropicAuthToken: 'third-party-token',
      }),
      NO_CUSTOM_ENV,
    );

    expect(lines).toContain('ANTHROPIC_BASE_URL=https://gateway.example.test');
    expect(lines).toContain('ANTHROPIC_API_KEY=third-party-token');
    expect(lines).toContain('ANTHROPIC_MODEL=test-model');
  });
});

describe('凭据链：宿主写入与刷新函数已删除', () => {
  const source = readSource('src/runtime-config.ts');

  test('不再导出凭据写入/刷新函数与凭据 scope 常量', () => {
    expect(source).not.toMatch(/export function writeCredentialsFile/);
    expect(source).not.toMatch(/export function updateAllSessionCredentials/);
    expect(source).not.toMatch(/DEFAULT_CREDENTIAL_SCOPES/);
  });

  test('group-queue 不再有凭据刷新专用关闭入口', () => {
    expect(readSource('src/group-queue.ts')).not.toMatch(
      /closeAllActiveForCredentialRefresh/,
    );
  });

  test('container-runner 不再写入 .credentials.json', () => {
    const runner = readSource('src/container-runner.ts');
    expect(runner).not.toMatch(/writeCredentialsFile/);
    expect(runner).not.toMatch(
      /Write \.credentials\.json for OAuth credentials/,
    );
  });

  test('第三方防护保留：oauthAccount 剥离与残留凭据清理', () => {
    const runner = readSource('src/container-runner.ts');
    expect(runner).toMatch(/delete stripped\.oauthAccount/);
    expect(runner).toMatch(/delete claudeJson\.oauthAccount/);
    expect(runner).toMatch(/unlinkSync\(staleCreds\)/);
    expect(runner).toMatch(/unlinkSync\(credsPath\)/);
  });
});

describe('V5 存储：第三方供应商无需迁移', () => {
  test('创建第三方供应商后文件仍为 version 5，字段往返不变', () => {
    const created = runtimeConfig.createProvider({
      name: 'thesis-05 gateway',
      type: 'third_party',
      anthropicBaseUrl: 'https://gateway.example.test',
      anthropicAuthToken: 'gateway-token',
      anthropicModel: 'glm-5.2',
      customEnv: { ANTHROPIC_CUSTOM_HEADERS: 'x-tenant: five' },
    });

    const raw = JSON.parse(fs.readFileSync(configFile, 'utf8')) as {
      version: number;
      providers: Array<Record<string, unknown>>;
    };
    expect(raw.version).toBe(5);

    const stored = raw.providers.find((item) => item.id === created.id);
    expect(stored).toMatchObject({
      type: 'third_party',
      anthropicBaseUrl: 'https://gateway.example.test',
      anthropicModel: 'glm-5.2',
      customEnv: { ANTHROPIC_CUSTOM_HEADERS: 'x-tenant: five' },
    });
    // 密钥只以密文落盘。
    expect(JSON.stringify(stored)).not.toContain('gateway-token');

    const roundTrip = runtimeConfig
      .getProviders()
      .find((item) => item.id === created.id);
    expect(roundTrip).toMatchObject({
      anthropicBaseUrl: 'https://gateway.example.test',
      anthropicAuthToken: 'gateway-token',
      anthropicModel: 'glm-5.2',
    });
  });
});

describe('D-3 ①：工作区容器环境变量不再暴露官方令牌字段', () => {
  test('ContainerEnvSchema 剥离 claudeCodeOauthToken', () => {
    const parsed = ContainerEnvSchema.safeParse({
      anthropicBaseUrl: 'https://workspace.example.test',
      claudeCodeOauthToken: 'legacy-oauth-token',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect('claudeCodeOauthToken' in parsed.data).toBe(false);
      expect(parsed.data.anthropicBaseUrl).toBe(
        'https://workspace.example.test',
      );
    }
  });

  test('公开视图不再返回官方令牌存在性与掩码', () => {
    type PublicInput = Parameters<
      typeof runtimeConfig.toPublicContainerEnvConfig
    >[0];
    const publicConfig = runtimeConfig.toPublicContainerEnvConfig({
      anthropicBaseUrl: 'https://workspace.example.test',
      anthropicAuthToken: 'workspace-token',
      claudeCodeOauthToken: 'legacy-oauth-token',
    } as unknown as PublicInput);

    expect('hasClaudeCodeOauthToken' in publicConfig).toBe(false);
    expect('claudeCodeOauthTokenMasked' in publicConfig).toBe(false);
    expect(publicConfig.hasAnthropicAuthToken).toBe(true);
    // 防未来把 config 整体展开导致原值泄漏。
    expect(JSON.stringify(publicConfig)).not.toContain('legacy-oauth-token');
  });

  test('供应商公开视图不再返回官方 OAuth 字段', () => {
    const provider = runtimeConfig.createProvider({
      name: 'thesis-05 public view',
      type: 'third_party',
      anthropicBaseUrl: 'https://public.example.test',
      anthropicAuthToken: 'public-token',
    });
    const publicProvider = runtimeConfig.toPublicProvider(provider);

    expect('hasClaudeCodeOauthToken' in publicProvider).toBe(false);
    expect('hasClaudeOAuthCredentials' in publicProvider).toBe(false);
    expect('claudeOAuthCredentialsExpiresAt' in publicProvider).toBe(false);
  });

  test('后端 PUT 路由与前端面板/store 不再携带该字段', () => {
    expect(readSource('src/routes/groups.ts')).not.toMatch(
      /claudeCodeOauthToken/,
    );
    expect(
      readSource('web/src/components/chat/ContainerEnvPanel.tsx'),
    ).not.toMatch(/claudeCodeOauthToken|hasClaudeCodeOauthToken/);
    expect(readSource('web/src/stores/container-env.ts')).not.toMatch(
      /claudeCodeOauthToken|hasClaudeCodeOauthToken/,
    );
  });
});

describe('容器模式工作区准备：不写凭据、保留第三方防护', () => {
  function workspaceGroup(folder: string) {
    return {
      name: folder,
      folder,
      added_at: new Date().toISOString(),
      created_by: 'thesis-05-owner',
      is_home: false,
    } as never;
  }

  function useThirdPartyProvider(): void {
    const provider = runtimeConfig.createProvider({
      name: 'thesis-05 container gateway',
      type: 'third_party',
      anthropicBaseUrl: 'https://gateway.example.test',
      anthropicAuthToken: 'container-token',
      anthropicModel: 'glm-5.2',
      enabled: true,
    });
    runtimeConfig.setDefaultProvider(provider.id);
  }

  test('第三方工作区准备后不保留 .credentials.json（清理块仍在）', () => {
    useThirdPartyProvider();
    const folder = 'thesis-05-container-workspace';
    const sessionDir = path.join(root, 'sessions', folder, '.claude');
    fs.mkdirSync(sessionDir, { recursive: true });
    const staleCreds = path.join(sessionDir, '.credentials.json');
    fs.writeFileSync(
      staleCreds,
      JSON.stringify({ claudeAiOauth: { accessToken: 'stale' } }),
    );

    buildVolumeMounts(workspaceGroup(folder), false);

    // 本用例锁定残留清理仍在（第三方防护）；写入块的删除由源码契约用例兜底。
    expect(fs.existsSync(staleCreds)).toBe(false);
  });

  test('容器模式 .claude.json 仍剥离 oauthAccount 与 cachedGrowthBookFeatures', () => {
    useThirdPartyProvider();
    fs.writeFileSync(
      path.join(FAKE_HOME, '.claude.json'),
      JSON.stringify({
        userID: 'thesis-05-user',
        oauthAccount: { emailAddress: 'legacy@example.test' },
        cachedGrowthBookFeatures: { tengu_bridge_repl_v2: true },
        autoUpdates: true,
      }),
    );

    buildVolumeMounts(workspaceGroup('thesis-05-container-json'), false);

    const generated = JSON.parse(
      fs.readFileSync(
        path.join(root, 'config', 'container-claude-json.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(generated.userID).toBe('thesis-05-user');
    expect(generated).not.toHaveProperty('oauthAccount');
    expect(generated).not.toHaveProperty('cachedGrowthBookFeatures');
    expect(generated.autoUpdates).toBe(false);
  });
});
