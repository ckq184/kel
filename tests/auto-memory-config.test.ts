import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';

import { removeTmpDirRecursive } from './helpers/remove-tmp-dir.js';

// Isolate DATA_DIR so the file-based fallback never reads this machine's real
// data/config/auto-memory.json (which carries live credentials).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-memory-config-'));

vi.mock('../src/config.js', async () => ({
  DATA_DIR: tmpDir,
}));

const { getAutoMemoryHostConfig, resetAutoMemoryConfigCache } =
  await import('../src/auto-memory-config.js');

// Task X write channel — imported lazily so a missing export fails the new
// tests (Red), not module load of the whole file.
const configModule = await import('../src/auto-memory-config.js');

const CONFIG_PATH = path.join(tmpDir, 'config', 'auto-memory.json');

afterAll(() => {
  removeTmpDirRecursive(tmpDir);
});

const GOOD_LLM = {
  baseUrl: 'https://llm.test/v1',
  apiKey: 'k1',
  model: 'gpt-m',
};
const GOOD_EMBEDDER = {
  baseUrl: 'https://embed.test/v1',
  apiKey: 'k2',
  model: 'embed-m',
};

describe('auto memory host config', () => {
  afterEach(() => {
    delete process.env.CKQCLAW_AUTO_MEMORY;
    resetAutoMemoryConfigCache();
  });

  test('default is disabled (tools degrade cleanly)', () => {
    resetAutoMemoryConfigCache();
    // Field-wise assertions only: a failure must never print the raw config
    // object into the vitest diff (it can carry live apiKeys).
    const config = getAutoMemoryHostConfig();
    expect(config.enabled).toBe(false);
    expect(config.llm).toBeUndefined();
    expect(config.embedder).toBeUndefined();
  });

  test('complete endpoint pair enables the feature', () => {
    process.env.CKQCLAW_AUTO_MEMORY = JSON.stringify({
      enabled: true,
      llm: GOOD_LLM,
      embedder: GOOD_EMBEDDER,
    });
    resetAutoMemoryConfigCache();
    const config = getAutoMemoryHostConfig();
    expect(config.enabled).toBe(true);
    expect(config.llm?.model).toBe('gpt-m');
    expect(config.embedder?.model).toBe('embed-m');
  });

  test('embedder alone is rejected — extraction and embedding are a pair', () => {
    process.env.CKQCLAW_AUTO_MEMORY = JSON.stringify({
      enabled: true,
      embedder: GOOD_EMBEDDER,
    });
    resetAutoMemoryConfigCache();
    expect(getAutoMemoryHostConfig().enabled).toBe(false);
  });

  test('non-http baseUrl or missing fields are dropped', () => {
    process.env.CKQCLAW_AUTO_MEMORY = JSON.stringify({
      enabled: true,
      llm: { baseUrl: 'ftp://x', apiKey: 'k', model: 'm' },
      embedder: GOOD_EMBEDDER,
    });
    resetAutoMemoryConfigCache();
    expect(getAutoMemoryHostConfig().enabled).toBe(false);
  });

  test('invalid JSON stays disabled', () => {
    process.env.CKQCLAW_AUTO_MEMORY = '{ broken';
    resetAutoMemoryConfigCache();
    const config = getAutoMemoryHostConfig();
    expect(config.enabled).toBe(false);
    expect(config.llm).toBeUndefined();
    expect(config.embedder).toBeUndefined();
  });
});

describe('auto memory config write channel (task X)', () => {
  afterEach(() => {
    delete process.env.CKQCLAW_AUTO_MEMORY;
    resetAutoMemoryConfigCache();
    fs.rmSync(CONFIG_PATH, { force: true });
  });

  test('source detection mirrors the read chain: env > file > none', () => {
    resetAutoMemoryConfigCache();
    expect(configModule.getAutoMemoryConfigSource()).toBe('none');

    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, '{}');
    resetAutoMemoryConfigCache();
    expect(configModule.getAutoMemoryConfigSource()).toBe('file');

    process.env.CKQCLAW_AUTO_MEMORY = '{ broken';
    expect(configModule.getAutoMemoryConfigSource()).toBe('env');
  });

  test('valid pair writes the file (0o600) and invalidates the read cache', () => {
    // Seed a stale cache first: the write must make the next read see it.
    resetAutoMemoryConfigCache();
    expect(getAutoMemoryHostConfig().enabled).toBe(false);

    const result = configModule.writeAutoMemoryHostConfig({
      llm: GOOD_LLM,
      embedder: GOOD_EMBEDDER,
    });
    expect(result.ok).toBe(true);

    const stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    expect(stored).toMatchObject({
      enabled: true,
      llm: GOOD_LLM,
      embedder: GOOD_EMBEDDER,
    });
    // Field-wise only — never snapshot the whole object into a diff (apiKeys).
    const stat = fs.statSync(CONFIG_PATH);
    // POSIX permission bits; on this repo's supported hosts mode 0o600 survives.
    expect(stat.mode & 0o777).toBe(0o600);

    const config = getAutoMemoryHostConfig();
    expect(config.enabled).toBe(true);
    expect(config.llm?.baseUrl).toBe('https://llm.test/v1');
    expect(config.embedder?.model).toBe('embed-m');
  });

  test('an invalid pair is rejected without touching the file', () => {
    for (const bad of [
      {
        llm: { baseUrl: 'ftp://x', apiKey: 'k', model: 'm' },
        embedder: GOOD_EMBEDDER,
      },
      {
        llm: { baseUrl: 'https://x', apiKey: '', model: 'm' },
        embedder: GOOD_EMBEDDER,
      },
      {
        llm: { baseUrl: 'https://x', apiKey: 'k', model: '' },
        embedder: GOOD_EMBEDDER,
      },
      { llm: GOOD_LLM, embedder: { baseUrl: 'https://x', apiKey: 'k' } },
      { llm: GOOD_LLM, embedder: undefined as unknown as typeof GOOD_EMBEDDER },
    ]) {
      const result = configModule.writeAutoMemoryHostConfig(bad);
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      if (!result.ok) expect(result.error).toBe('invalid_endpoints');
    }
    expect(fs.existsSync(CONFIG_PATH)).toBe(false);
  });

  test('env override refuses writes and clears (no silent dual-channel drift)', () => {
    process.env.CKQCLAW_AUTO_MEMORY = JSON.stringify({
      enabled: true,
      llm: GOOD_LLM,
      embedder: GOOD_EMBEDDER,
    });
    resetAutoMemoryConfigCache();

    const write = configModule.writeAutoMemoryHostConfig({
      llm: GOOD_LLM,
      embedder: GOOD_EMBEDDER,
    });
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.error).toBe('env_override');
    expect(fs.existsSync(CONFIG_PATH)).toBe(false);

    const clear = configModule.clearAutoMemoryHostConfig();
    expect(clear.ok).toBe(false);
    if (!clear.ok) expect(clear.error).toBe('env_override');
  });

  test('clear removes the file and the read cache follows (idempotent)', () => {
    configModule.writeAutoMemoryHostConfig({
      llm: GOOD_LLM,
      embedder: GOOD_EMBEDDER,
    });
    expect(getAutoMemoryHostConfig().enabled).toBe(true);

    expect(configModule.clearAutoMemoryHostConfig().ok).toBe(true);
    expect(fs.existsSync(CONFIG_PATH)).toBe(false);
    expect(getAutoMemoryHostConfig().enabled).toBe(false);

    // Clearing again stays ok (DELETE is idempotent at the API layer).
    expect(configModule.clearAutoMemoryHostConfig().ok).toBe(true);
  });
});
