import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-config-default-'));

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
const { trySelectPoolProvider } = await import('../src/container-runner.js');
const configFile = path.join(root, 'config', 'claude-provider.json');

beforeAll(() => {
  fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  fs.mkdirSync(path.join(root, 'groups'), { recursive: true });
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('default model configuration', () => {
  test('strips root-side permission controls from saved Workspace env', () => {
    runtimeConfig.saveContainerEnvConfig('permission-env-workspace', {
      customEnv: {
        CKQCLAW_INTERNAL_IDENTITY_MODE: 'direct',
        CKQCLAW_PASSWD_FILE: '/workspace/group/passwd',
        CKQCLAW_SESSION_PERMISSION_HELPER: '/workspace/group/evil.sh',
        PROJECT_ENV: 'kept',
      },
    });

    expect(
      runtimeConfig.getContainerEnvConfig('permission-env-workspace').customEnv,
    ).toEqual({ PROJECT_ENV: 'kept' });
  });

  test('selects one complete Provider environment as the default', () => {
    const first = runtimeConfig.createProvider({
      name: 'Official subscription',
      type: 'official',
      anthropicApiKey: 'official-key',
      anthropicModel: 'sonnet',
      enabled: true,
    });
    const second = runtimeConfig.createProvider({
      name: 'Model gateway',
      type: 'third_party',
      anthropicBaseUrl: 'https://gateway.example.test',
      anthropicAuthToken: 'gateway-token',
      anthropicModel: 'gateway-model',
      customEnv: { ANTHROPIC_CUSTOM_HEADERS: 'x-tenant: model-b' },
      enabled: true,
    });

    expect(runtimeConfig.getDefaultProviderId()).toBe(first.id);
    runtimeConfig.setDefaultProvider(second.id);
    expect(runtimeConfig.getDefaultProviderId()).toBe(second.id);
    expect(runtimeConfig.getClaudeProviderConfig()).toMatchObject({
      anthropicBaseUrl: 'https://gateway.example.test',
      anthropicAuthToken: 'gateway-token',
      anthropicModel: 'gateway-model',
    });
    expect(runtimeConfig.getActiveProfileCustomEnv()).toEqual({
      ANTHROPIC_CUSTOM_HEADERS: 'x-tenant: model-b',
    });
    expect(() => runtimeConfig.setProviderEnabled(second.id, false)).toThrow(
      '默认模型配置不能禁用',
    );
    expect(() => runtimeConfig.deleteProvider(second.id)).toThrow(
      '默认模型配置不能删除',
    );
  });

  test('Agent selection overrides a legacy Workspace Provider environment', () => {
    const selected = runtimeConfig.createProvider({
      name: 'Agent-only model gateway',
      type: 'third_party',
      anthropicBaseUrl: 'https://agent-only.example.test',
      anthropicAuthToken: 'agent-only-token',
      anthropicModel: 'agent-only-model',
      customEnv: { ANTHROPIC_CUSTOM_HEADERS: 'x-tenant: agent-only' },
      enabled: false,
    });
    runtimeConfig.saveContainerEnvConfig('model-workspace', {
      anthropicBaseUrl: 'https://workspace-override.example.test',
      anthropicAuthToken: 'workspace-token',
      anthropicModel: 'workspace-model',
    });

    const result = trySelectPoolProvider('model-workspace', null, selected.id);
    expect(result).toMatchObject({
      profileId: selected.id,
      resolved: {
        config: {
          anthropicBaseUrl: 'https://agent-only.example.test',
          anthropicAuthToken: 'agent-only-token',
          anthropicModel: 'agent-only-model',
        },
        customEnv: { ANTHROPIC_CUSTOM_HEADERS: 'x-tenant: agent-only' },
      },
    });
    expect(db.getSessionProviderId('model-workspace')).toBe(selected.id);
  });

  test('migrates V4 by choosing the first enabled configuration', () => {
    const stored = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<
      string,
      unknown
    >;
    stored.version = 4;
    delete stored.defaultProviderId;
    fs.writeFileSync(configFile, `${JSON.stringify(stored, null, 2)}\n`);

    const firstEnabledId = runtimeConfig
      .getProviders()
      .find((provider) => provider.enabled)!.id;
    expect(runtimeConfig.getDefaultProviderId()).toBe(firstEnabledId);

    const migrated = JSON.parse(fs.readFileSync(configFile, 'utf8')) as {
      version: number;
      defaultProviderId: string;
    };
    expect(migrated).toMatchObject({
      version: 5,
      defaultProviderId: firstEnabledId,
    });
  });
});

describe('provider context window declaration (任务AL)', () => {
  test('round-trips a declared window through CRUD, public view and env lines', () => {
    const provider = runtimeConfig.createProvider({
      name: 'Declared window gateway',
      type: 'third_party',
      anthropicBaseUrl: 'https://declared.example.test',
      anthropicAuthToken: 'declared-token',
      anthropicModel: 'glm-5.2',
      contextWindow: 512_000,
      enabled: false,
    });

    // 回显：公开视图带声明值
    expect(runtimeConfig.toPublicProvider(provider).contextWindow).toBe(
      512_000,
    );

    // 存储往返：resolveProviderById → config → env 注入
    const resolved = runtimeConfig.resolveProviderById(provider.id);
    expect(resolved.config.contextWindow).toBe(512_000);
    const lines = runtimeConfig.buildContainerEnvLines(
      resolved.config,
      { customEnv: {} },
      resolved.customEnv,
    );
    expect(lines).toContain('CKQCLAW_CONTEXT_WINDOW=512000');
    expect(lines).toContain('ANTHROPIC_MODEL=glm-5.2');
    expect(lines).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=512000');

    // patch 回 auto：不再注入声明 env
    const patched = runtimeConfig.updateProvider(provider.id, {
      contextWindow: 'auto',
    });
    expect(runtimeConfig.toPublicProvider(patched).contextWindow).toBe('auto');
    const autoLines = runtimeConfig.buildContainerEnvLines(
      runtimeConfig.resolveProviderById(provider.id).config,
      { customEnv: {} },
      {},
    );
    expect(
      autoLines.some((line) => line.startsWith('CKQCLAW_CONTEXT_WINDOW=')),
    ).toBe(false);
    expect(autoLines).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000');
  });

  test('legacy [1m] provider migrates to stripped model plus 1M declaration', () => {
    const provider = runtimeConfig.createProvider({
      name: 'Legacy suffix gateway',
      type: 'third_party',
      anthropicBaseUrl: 'https://legacy.example.test',
      anthropicAuthToken: 'legacy-token',
      anthropicModel: 'glm-5.2[1m]',
      enabled: false,
    });

    const resolved = runtimeConfig.resolveProviderById(provider.id);
    const lines = runtimeConfig.buildContainerEnvLines(
      resolved.config,
      { customEnv: {} },
      resolved.customEnv,
    );
    // 存量兼容：模型名剥离上送，窗口等价迁移为 1M 声明
    expect(lines).toContain('ANTHROPIC_MODEL=glm-5.2');
    expect(lines).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.2');
    expect(lines).toContain('CKQCLAW_CONTEXT_WINDOW=1000000');
    expect(lines).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000');
  });

  test('schema accepts only the declared preset domain', async () => {
    const { UnifiedProviderCreateSchema } = await import('../src/schemas.js');
    const base = {
      name: 'ok',
      type: 'third_party' as const,
      anthropicBaseUrl: 'https://schema.example.test',
    };

    expect(
      UnifiedProviderCreateSchema.safeParse({
        ...base,
        contextWindow: 256_000,
      }).success,
    ).toBe(true);
    expect(
      UnifiedProviderCreateSchema.safeParse({
        ...base,
        contextWindow: 'auto',
      }).success,
    ).toBe(true);
    expect(
      UnifiedProviderCreateSchema.safeParse({
        ...base,
        contextWindow: 123_456,
      }).success,
    ).toBe(false);
    expect(
      UnifiedProviderCreateSchema.safeParse({
        ...base,
        contextWindow: '1m',
      }).success,
    ).toBe(false);
  });
});
