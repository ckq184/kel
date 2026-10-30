import { describe, expect, test } from 'vitest';

import {
  MCP_SERVERS_ENV,
  createCkqclawMcpExtension,
  parseExternalMcpServers,
} from '../src/runtime/pi/pi-mcp.js';

describe('parseExternalMcpServers', () => {
  test('empty or missing env yields no servers and no errors', () => {
    expect(parseExternalMcpServers(undefined)).toEqual({
      servers: [],
      errors: [],
    });
    expect(parseExternalMcpServers('')).toEqual({ servers: [], errors: [] });
    expect(parseExternalMcpServers('   ')).toEqual({
      servers: [],
      errors: [],
    });
  });

  test('malformed JSON fails closed with an error and zero servers', () => {
    const result = parseExternalMcpServers('{not json');
    expect(result.servers).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(MCP_SERVERS_ENV);
    expect(result.errors[0]).toContain('not valid JSON');
  });

  test('non-object JSON fails closed', () => {
    const result = parseExternalMcpServers('["playwright"]');
    expect(result.servers).toEqual([]);
    expect(result.errors[0]).toContain('must be a JSON object');
  });

  test('stdio entry maps with direct exposure', () => {
    const result = parseExternalMcpServers(
      JSON.stringify({
        playwright: {
          command: 'playwright-mcp',
          args: ['--browser', 'chromium'],
          env: { SEARXNG_URL: 'http://127.0.0.1:8080' },
        },
      }),
    );
    expect(result.errors).toEqual([]);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]).toEqual({
      name: 'playwright',
      config: {
        command: 'playwright-mcp',
        args: ['--browser', 'chromium'],
        env: { SEARXNG_URL: 'http://127.0.0.1:8080' },
        exposure: 'direct',
      },
      source: `env:${MCP_SERVERS_ENV}`,
    });
  });

  test('http entry maps url and headers', () => {
    const result = parseExternalMcpServers(
      JSON.stringify({
        searxng: {
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer token' },
        },
      }),
    );
    expect(result.errors).toEqual([]);
    expect(result.servers[0]?.config).toEqual({
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' },
      exposure: 'direct',
    });
  });

  test('invalid entries are skipped without blocking valid ones', () => {
    const result = parseExternalMcpServers(
      JSON.stringify({
        'bad name!': { command: 'x' },
        no_command: {},
        ok: { command: 'runs' },
      }),
    );
    expect(result.servers.map((s) => s.name)).toEqual(['ok']);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain('bad name!');
    expect(result.errors[1]).toContain('no_command');
  });

  test('legacy SSE transport is rejected', () => {
    const result = parseExternalMcpServers(
      JSON.stringify({
        legacy: { type: 'sse', url: 'https://example.com/sse' },
      }),
    );
    expect(result.servers).toEqual([]);
    expect(result.errors[0]).toContain('SSE');
  });

  test('exposure is forced to direct even when the entry asks for another mode', () => {
    const result = parseExternalMcpServers(
      JSON.stringify({
        codemode_server: { command: 'x', exposure: 'codemode' },
      }),
    );
    // The runner loads neither the codemode nor the tool-search extension, so
    // anything but direct exposure would leave the tools unreachable.
    expect(result.servers[0]?.config.exposure).toBe('direct');
  });

  test('non-string env values are rejected fail-closed', () => {
    const result = parseExternalMcpServers(
      JSON.stringify({
        broken: { command: 'x', env: { PORT: 8080 } },
      }),
    );
    expect(result.servers).toEqual([]);
    expect(result.errors[0]).toContain('"env"');
  });

  test('non-string args entries are rejected', () => {
    const result = parseExternalMcpServers(
      JSON.stringify({ broken: { command: 'x', args: ['--flag', 42] } }),
    );
    expect(result.servers).toEqual([]);
    expect(result.errors[0]).toContain('"args"');
  });

  test('invalid timeout is rejected, valid timeout passes through', () => {
    const bad = parseExternalMcpServers(
      JSON.stringify({ a: { command: 'x', timeout: -5 } }),
    );
    expect(bad.servers).toEqual([]);
    expect(bad.errors[0]).toContain('"timeout"');

    const good = parseExternalMcpServers(
      JSON.stringify({ a: { command: 'x', timeout: 120 } }),
    );
    expect(good.errors).toEqual([]);
    expect(good.servers[0]?.config).toMatchObject({ timeout: 120 });
  });

  test('createCkqclawMcpExtension returns a usable extension factory', () => {
    expect(createCkqclawMcpExtension()).toBeTruthy();
  });
});
