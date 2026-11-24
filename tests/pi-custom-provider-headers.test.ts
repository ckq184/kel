import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

import {
  escapePiConfigLiteral,
  parseCustomHeaders,
  resolvePiProvider,
} from '../container/agent-runner/src/runtime/pi/pi-provider.js';

const RUNNER_SRC = path.resolve(__dirname, '../container/agent-runner/src');

async function createModelRuntime(): Promise<ModelRuntime> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckqclaw-pi-headers-'));
  const authPath = path.join(dir, 'auth.json');
  const modelsPath = path.join(dir, 'models.json');
  fs.writeFileSync(authPath, '{}\n');
  fs.writeFileSync(modelsPath, '{}\n');
  return ModelRuntime.create({ authPath, modelsPath, refreshOnCreate: false });
}

describe('ISSUE-18 parseCustomHeaders (Claude Code `Name: value` per line)', () => {
  test('undefined or blank input yields no headers and no warnings', () => {
    expect(parseCustomHeaders(undefined)).toEqual({
      headers: {},
      warnings: [],
    });
    expect(parseCustomHeaders('  \n\n')).toEqual({ headers: {}, warnings: [] });
  });

  test('parses multiple lines, trims whitespace, tolerates CRLF', () => {
    const result = parseCustomHeaders(
      'x-test-session: abc-123\r\n\r\n  X-Other :  value with spaces  \n',
    );
    expect(result.headers).toEqual({
      'x-test-session': 'abc-123',
      'X-Other': 'value with spaces',
    });
    expect(result.warnings).toEqual([]);
  });

  test('keeps colons inside the value', () => {
    expect(parseCustomHeaders('x-trace: a:b:c').headers).toEqual({
      'x-trace': 'a:b:c',
    });
  });

  test('skips invalid lines with a warning that never contains the value', () => {
    const result = parseCustomHeaders(
      [
        'no-colon-line-secret',
        ': secret-without-name',
        'bad name: secret-1',
        'x-empty:   ',
        'x-ctl: secret\u0001value',
        'x-good: ok',
      ].join('\n'),
    );
    expect(result.headers).toEqual({ 'x-good': 'ok' });
    expect(result.warnings).toHaveLength(5);
    expect(result.warnings.map((w) => w.line)).toEqual([1, 2, 3, 4, 5]);
    for (const warning of result.warnings) {
      expect(warning.message).not.toMatch(/secret/);
    }
  });

  test('later duplicate wins case-insensitively', () => {
    const result = parseCustomHeaders('X-Dup: first\nx-dup: second');
    expect(result.headers).toEqual({ 'x-dup': 'second' });
  });
});

describe('ISSUE-18 escapePiConfigLiteral', () => {
  test('neutralizes Pi template and command syntax', () => {
    expect(escapePiConfigLiteral('plain')).toBe('plain');
    expect(escapePiConfigLiteral('a$HOME')).toBe('a$$HOME');
    expect(escapePiConfigLiteral('!echo hi')).toBe('$!echo hi');
    expect(escapePiConfigLiteral('mid!bang')).toBe('mid!bang');
  });
});

describe('ISSUE-18 resolvePiProvider forwards custom headers', () => {
  test('custom endpoint requests carry the headers as literals', async () => {
    const modelRuntime = await createModelRuntime();
    const resolution = await resolvePiProvider(modelRuntime, {
      model: 'glm-5.2',
      endpointKind: 'custom',
      baseUrl: 'https://proxy.test',
      apiKey: 'fake-key',
      headers: {
        'x-test-session': 'fixed-1',
        'x-literal': '$HOME',
        'x-bang': '!echo pwned',
      },
    });

    const auth = await modelRuntime.getAuth(resolution.model);
    expect(auth?.auth.headers).toMatchObject({
      'x-test-session': 'fixed-1',
      'x-literal': '$HOME',
      'x-bang': '!echo pwned',
    });
  });

  test('custom endpoint headers apply even without an api key', async () => {
    const modelRuntime = await createModelRuntime();
    const registered: Array<Record<string, unknown>> = [];
    const original = modelRuntime.registerProvider.bind(modelRuntime);
    modelRuntime.registerProvider = ((id: string, config: any) => {
      registered.push(config);
      return original(id, config);
    }) as typeof modelRuntime.registerProvider;

    await resolvePiProvider(modelRuntime, {
      model: 'glm-5.2',
      endpointKind: 'custom',
      baseUrl: 'https://proxy.test',
      headers: { 'x-test-session': 'fixed-1' },
    });

    const models = registered[0].models as Array<Record<string, unknown>>;
    expect(models[0].headers).toEqual({ 'x-test-session': 'fixed-1' });
  });

  test('without headers the registration carries no headers field', async () => {
    const modelRuntime = await createModelRuntime();
    const registered: Array<Record<string, unknown>> = [];
    const original = modelRuntime.registerProvider.bind(modelRuntime);
    modelRuntime.registerProvider = ((id: string, config: any) => {
      registered.push(config);
      return original(id, config);
    }) as typeof modelRuntime.registerProvider;

    for (const headers of [undefined, {}]) {
      await resolvePiProvider(modelRuntime, {
        model: 'glm-5.2',
        endpointKind: 'custom',
        baseUrl: 'https://proxy.test',
        headers,
      });
    }

    for (const config of registered) {
      expect(config).not.toHaveProperty('headers');
      const models = config.models as Array<Record<string, unknown>>;
      expect(models[0]).not.toHaveProperty('headers');
    }
  });

  test('official endpoint is rejected before registering a provider', async () => {
    const modelRuntime = await createModelRuntime();
    let registerCalls = 0;
    modelRuntime.registerProvider = (() => {
      registerCalls += 1;
    }) as typeof modelRuntime.registerProvider;

    await expect(
      resolvePiProvider(modelRuntime, {
        model: 'claude-haiku-4-5',
        endpointKind: 'official',
        apiKey: 'fake-key',
        headers: { 'x-test-session': 'fixed-1' },
      }),
    ).rejects.toThrow(/no longer supported/i);

    expect(registerCalls).toBe(0);
  });
});

describe('ISSUE-18 production wiring source contracts', () => {
  test('pi-index reads ANTHROPIC_CUSTOM_HEADERS and forwards parsed headers', () => {
    const src = fs.readFileSync(path.join(RUNNER_SRC, 'pi-index.ts'), 'utf8');
    expect(src).toMatch(
      /parseCustomHeaders\(\s*process\.env\.ANTHROPIC_CUSTOM_HEADERS/,
    );
    expect(src).toMatch(/headers:\s*customHeaders\.headers/);
  });

  test('pi-runtime adapter forwards provider headers to resolvePiProvider', () => {
    const src = fs.readFileSync(
      path.join(RUNNER_SRC, 'runtime/pi/pi-runtime.ts'),
      'utf8',
    );
    expect(src).toMatch(/headers:\s*options\.provider\?\.headers/);
  });
});
