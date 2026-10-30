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
    delete process.env.MINICLAW_AUTO_MEMORY;
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
    process.env.MINICLAW_AUTO_MEMORY = JSON.stringify({
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
    process.env.MINICLAW_AUTO_MEMORY = JSON.stringify({
      enabled: true,
      embedder: GOOD_EMBEDDER,
    });
    resetAutoMemoryConfigCache();
    expect(getAutoMemoryHostConfig().enabled).toBe(false);
  });

  test('non-http baseUrl or missing fields are dropped', () => {
    process.env.MINICLAW_AUTO_MEMORY = JSON.stringify({
      enabled: true,
      llm: { baseUrl: 'ftp://x', apiKey: 'k', model: 'm' },
      embedder: GOOD_EMBEDDER,
    });
    resetAutoMemoryConfigCache();
    expect(getAutoMemoryHostConfig().enabled).toBe(false);
  });

  test('invalid JSON stays disabled', () => {
    process.env.MINICLAW_AUTO_MEMORY = '{ broken';
    resetAutoMemoryConfigCache();
    const config = getAutoMemoryHostConfig();
    expect(config.enabled).toBe(false);
    expect(config.llm).toBeUndefined();
    expect(config.embedder).toBeUndefined();
  });
});
