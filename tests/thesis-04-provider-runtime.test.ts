import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

/**
 * D-2 ② (THESIS-04): the host only builds a provider from environment
 * variables when ANTHROPIC_BASE_URL is present. Official-only credentials
 * (CLAUDE_CODE_OAUTH_TOKEN, or ANTHROPIC_API_KEY without a base URL) no longer
 * form a usable provider, and the container env never declares an `official`
 * endpoint marker.
 */
const mockRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'thesis-04-provider-runtime-'),
);

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: mockRoot,
  STORE_DIR: path.join(mockRoot, 'db'),
  GROUPS_DIR: path.join(mockRoot, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const runtimeConfig = await import('../src/runtime-config.js');

const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_MODEL',
] as const;

const ORIGINAL_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    ORIGINAL_ENV[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
});

afterAll(() => {
  fs.rmSync(mockRoot, { recursive: true, force: true });
});

const EMPTY_CONFIG = {
  anthropicBaseUrl: '',
  anthropicAuthToken: '',
  anthropicApiKey: '',
  claudeCodeOauthToken: '',
  claudeOAuthCredentials: null,
  anthropicModel: '',
  updatedAt: null,
} as const;

describe('host environment fallback (D-2 ②)', () => {
  test('an API key without a base URL no longer forms a provider', () => {
    process.env.ANTHROPIC_API_KEY = 'fake-api-key';

    const config = runtimeConfig.getClaudeProviderConfig();

    expect(config.anthropicBaseUrl).toBe('');
    expect(config.anthropicApiKey).toBe('');
    expect(config.claudeCodeOauthToken).toBe('');
  });

  test('a legacy OAuth token without a base URL no longer forms a provider', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fake-oauth-token';

    const config = runtimeConfig.getClaudeProviderConfig();

    expect(config.anthropicBaseUrl).toBe('');
    expect(config.claudeCodeOauthToken).toBe('');
  });

  test('base URL plus auth token still works from the environment', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.test';
    process.env.ANTHROPIC_AUTH_TOKEN = 'fake-auth-token';
    process.env.ANTHROPIC_MODEL = 'glm-5.2';

    const config = runtimeConfig.getClaudeProviderConfig();

    expect(config).toMatchObject({
      anthropicBaseUrl: 'https://proxy.test',
      anthropicAuthToken: 'fake-auth-token',
      anthropicModel: 'glm-5.2',
    });
  });

  test('base URL plus API key still works from the environment', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.test';
    process.env.ANTHROPIC_API_KEY = 'fake-api-key';
    process.env.ANTHROPIC_MODEL = 'glm-5.2';

    const config = runtimeConfig.getClaudeProviderConfig();

    expect(config).toMatchObject({
      anthropicBaseUrl: 'https://proxy.test',
      anthropicApiKey: 'fake-api-key',
      anthropicModel: 'glm-5.2',
    });
  });
});

describe('endpoint marker derivation (D-2 ②)', () => {
  test('declares a custom marker only when a base URL exists', () => {
    const withBase = runtimeConfig.buildContainerEnvLines(
      {
        ...EMPTY_CONFIG,
        anthropicBaseUrl: 'https://proxy.test',
        anthropicModel: 'glm-5.2',
      },
      {},
      {},
    );
    const withoutBase = runtimeConfig.buildContainerEnvLines(
      { ...EMPTY_CONFIG },
      {},
      {},
    );

    expect(withBase).toContain('CKQCLAW_CLAUDE_ENDPOINT_KIND=custom');
    expect(
      withoutBase.some((line) =>
        line.startsWith('CKQCLAW_CLAUDE_ENDPOINT_KIND='),
      ),
    ).toBe(false);
  });
});

describe('runner source contracts (D-2 ②)', () => {
  test('the provider resolver no longer imports the compat model catalog', () => {
    const source = fs.readFileSync(
      path.resolve('container/agent-runner/src/runtime/pi/pi-provider.ts'),
      'utf8',
    );

    expect(source).not.toMatch(/@earendil-works\/pi-ai\/compat/);
    expect(source).not.toMatch(/setRuntimeApiKey\(\s*'anthropic'/);
  });

  test('the runner entrypoint surfaces the provider configuration error', () => {
    const source = fs.readFileSync(
      path.resolve('container/agent-runner/src/pi-index.ts'),
      'utf8',
    );

    expect(source).toMatch(/provider\.providerError/);
  });
});
