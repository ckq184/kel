/**
 * Secret-surface test for the auto-memory bootstrap narrowing (T4,
 * sidecar-ownership plan): the stdin bootstrap sent to runners — docker and
 * host-mode alike — carries only the auto-memory enable flag. llm/embedder
 * endpoints (apiKey/baseUrl/model) live host-side, feeding the host-owned
 * sidecar; they must never enter a runner's bootstrap JSON.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';

const SHARED_TMP = fs.mkdtempSync(
  path.join(fs.realpathSync(os.tmpdir()), 'am-narrow-'),
);

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: path.join(SHARED_TMP, 'data'),
    GROUPS_DIR: path.join(SHARED_TMP, 'data', 'groups'),
    STORE_DIR: path.join(SHARED_TMP, 'data', 'db'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

const { buildAutoMemoryInput } = await import('../src/container-runner.js');
const { resetAutoMemoryConfigCache } = await import(
  '../src/auto-memory-config.js'
);

afterAll(() => {
  fs.rmSync(SHARED_TMP, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.MINICLAW_AUTO_MEMORY;
  resetAutoMemoryConfigCache();
});

const FULL_ENDPOINTS = JSON.stringify({
  enabled: true,
  llm: { baseUrl: 'https://llm.test/v1', apiKey: 'secret-llm-key', model: 'm' },
  embedder: {
    baseUrl: 'https://embed.test/v1',
    apiKey: 'secret-embed-key',
    model: 'e',
  },
});

/** Recursively collect every key name reachable in a JSON-serializable value. */
function allKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, into);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      allKeys(child, into);
    }
  }
  return into;
}

describe('buildAutoMemoryInput secret surface', () => {
  test('fully configured host sends only the enable flag', () => {
    process.env.MINICLAW_AUTO_MEMORY = FULL_ENDPOINTS;
    resetAutoMemoryConfigCache();
    const input = buildAutoMemoryInput();
    // Deep equality pins the exact shape: no dataPath, no endpoints.
    expect(input).toEqual({ enabled: true });
  });

  test('bootstrap JSON contains no endpoint keys anywhere', () => {
    process.env.MINICLAW_AUTO_MEMORY = FULL_ENDPOINTS;
    resetAutoMemoryConfigCache();
    const keys = allKeys(buildAutoMemoryInput());
    for (const forbidden of ['apiKey', 'baseUrl', 'model', 'llm', 'embedder', 'dataPath']) {
      expect(keys.has(forbidden), `bootstrap must not carry key "${forbidden}"`).toBe(false);
    }
  });

  test('disabled host sends nothing at all', () => {
    delete process.env.MINICLAW_AUTO_MEMORY;
    resetAutoMemoryConfigCache();
    expect(buildAutoMemoryInput()).toBeUndefined();
  });
});

describe('runner-side stdin bootstrap source (fail-closed mirror check)', () => {
  test('docker and host call sites build via buildAutoMemoryInput with no path or endpoints', () => {
    const source = fs.readFileSync(
      path.resolve('src/container-runner.ts'),
      'utf8',
    );
    const callSites = source.match(/buildAutoMemoryInput\([^)]*\)/g) ?? [];
    expect(callSites.length).toBeGreaterThanOrEqual(2);
    for (const call of callSites) {
      expect(call).not.toMatch(/extra|GROUPS_DIR|dataPath/);
    }
  });
});
