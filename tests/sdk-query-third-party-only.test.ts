/**
 * THESIS-17：宿主一次性模型调用 `sdkQuery` 与 D-2 ② 对齐，只剩第三方路径。
 *
 * 没有 Base URL 时不再向 Pi 注入官方 anthropic 运行时密钥、也不再读取内置
 * 官方模型目录；`resolveModel` 抛错由 `sdkQuery` 的 catch 转为 null。有
 * Base URL 时仍注册 `ckqclaw-*` provider。
 *
 * Pi runtime、会话、配置与 logger 全部 mock；`DATA_DIR` 指向系统临时目录并
 * spy 掉 `mkdirSync`，不触碰真实凭据、网络或 data/。
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const pi = vi.hoisted(() => {
  const session = {
    bindExtensions: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
    prompt: vi.fn(async () => {}),
    dispose: vi.fn(),
    abort: vi.fn(async () => {}),
  };
  return {
    session,
    setRuntimeApiKey: vi.fn(async () => {}),
    getModels: vi.fn(() => [{ id: 'official-model' }]),
    getModel: vi.fn(() => ({ id: 'resolved-model' })),
    registerProvider: vi.fn(),
    createAgentSession: vi.fn(async () => ({ session })),
  };
});

vi.mock('@earendil-works/pi-coding-agent', () => ({
  ModelRuntime: {
    create: vi.fn(async () => ({
      setRuntimeApiKey: pi.setRuntimeApiKey,
      getModels: pi.getModels,
      getModel: pi.getModel,
      registerProvider: pi.registerProvider,
    })),
  },
  SettingsManager: { create: vi.fn(() => ({})) },
  DefaultResourceLoader: class {
    reload = vi.fn(async () => {});
  },
  createAgentSession: pi.createAgentSession,
  SessionManager: { inMemory: vi.fn(() => ({})) },
}));

vi.mock('../src/runtime-config.js', () => ({
  getClaudeProviderConfig: vi.fn(),
}));

vi.mock('../src/config.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return { DATA_DIR: path.join(os.tmpdir(), 'ckqclaw-thesis-17-sdk-query') };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const runtimeConfig = await import('../src/runtime-config.js');
const { logger } = await import('../src/logger.js');
const { sdkQuery } = await import('../src/sdk-query.js');

function providerConfig(overrides: Record<string, unknown> = {}) {
  return {
    anthropicBaseUrl: '',
    anthropicApiKey: '',
    anthropicAuthToken: '',
    anthropicModel: '',
    ...overrides,
  } as ReturnType<typeof runtimeConfig.getClaudeProviderConfig>;
}

let mkdirSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
});

afterEach(() => {
  // 只还原 fs spy；restoreAllMocks 会重置 hoisted vi.fn 的实现。
  mkdirSpy.mockRestore();
});

describe('sdkQuery only uses the third-party path', () => {
  test('no base URL: returns null without the official runtime key or model catalog', async () => {
    vi.mocked(runtimeConfig.getClaudeProviderConfig).mockReturnValue(
      providerConfig({ anthropicApiKey: 'sk-official' }),
    );

    await expect(sdkQuery('summarize this')).resolves.toBeNull();

    expect(pi.setRuntimeApiKey).not.toHaveBeenCalled();
    expect(pi.getModels).not.toHaveBeenCalled();
    expect(pi.registerProvider).not.toHaveBeenCalled();
    expect(pi.createAgentSession).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  test('base URL: still registers the ckqclaw provider and runs the query', async () => {
    vi.mocked(runtimeConfig.getClaudeProviderConfig).mockReturnValue(
      providerConfig({
        anthropicBaseUrl: 'https://gateway.example.test',
        anthropicApiKey: 'sk-third-party',
        anthropicModel: 'zai/glm-4.6',
      }),
    );

    // 假会话不产生文本，sdkQuery 正常结束并返回 null。
    await expect(sdkQuery('hello')).resolves.toBeNull();

    expect(pi.registerProvider).toHaveBeenCalledWith(
      'ckqclaw-zai',
      expect.objectContaining({
        baseUrl: 'https://gateway.example.test',
        api: 'anthropic-messages',
        apiKey: 'sk-third-party',
      }),
    );
    expect(pi.getModel).toHaveBeenCalledWith('ckqclaw-zai', 'glm-4.6');
    expect(logger.warn).not.toHaveBeenCalled();
    expect(pi.createAgentSession).toHaveBeenCalledOnce();
    expect(pi.session.prompt).toHaveBeenCalledWith('hello');
    expect(pi.setRuntimeApiKey).not.toHaveBeenCalled();
    expect(pi.getModels).not.toHaveBeenCalled();
  });
});
