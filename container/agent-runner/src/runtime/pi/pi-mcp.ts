import {
  createMcpExtension,
  type ExtensionFactory,
} from '@earendil-works/pi-coding-agent';

/**
 * External MCP loader for the Pi runner.
 *
 * The host resolves `/mcp-servers` (plus managed/workspace layers) into a
 * Claude-format `mcpServers` map and ships it in
 * `MINICLAW_USER_MCP_SERVERS_JSON` — the exact shape Pi's `mcp.json` uses.
 * Pi's built-in MCP extension is wired with a custom `loadConfig` that reads
 * that env instead of `mcp.json` files, so no filesystem config source or
 * project-trust grant is involved.
 *
 * Tools surface as `mcp__<server>__<tool>` with `direct` exposure: declared
 * to the model like built-in tools, which matches the product capability
 * model and keeps every call flowing through the `tool_call` approval gate
 * (Pi routes all MCP calls through the tool pipeline, and the bare-name
 * policy fallback in approval/policy.ts resolves `mcp__<server>__<name>`
 * against bare entries like `browser_evaluate`).
 *
 * Fail-closed mapping: entries that are not unambiguously stdio or HTTP are
 * reported as errors and skipped — a malformed server never degrades into a
 * partially-built command line. Individual failures do not block the other
 * servers, mirroring Pi's own config handling.
 */

export const MCP_SERVERS_ENV = 'MINICLAW_USER_MCP_SERVERS_JSON';

/** Pi server names allow letters, digits, `_` and `-` only. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

const NAME_SOURCE = `env:${MCP_SERVERS_ENV}`;

/** Mirrors Pi's stdio `McpServerConfig` branch (not re-exported by the SDK). */
export interface ExternalStdioServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
  exposure: 'direct';
}

/** Mirrors Pi's streamable-HTTP `McpServerConfig` branch. */
export interface ExternalHttpServerConfig {
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
  exposure: 'direct';
}

export type ExternalServerConfig =
  | ExternalStdioServerConfig
  | ExternalHttpServerConfig;

/** Structurally compatible with Pi's `LoadedMcpConfig` (not re-exported). */
export interface ExternalMcpConfig {
  servers: Array<{
    name: string;
    config: ExternalServerConfig;
    source: string;
  }>;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalStringRecord(
  value: unknown,
): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') return undefined;
    out[key] = entry;
  }
  return out;
}

function optionalTimeout(
  value: unknown,
  errors: (name: string, problem: string) => void,
  name: string,
): { ok: true; value?: number } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    errors(name, '"timeout" must be a positive number of seconds');
    return { ok: false };
  }
  return { ok: true, value };
}

function buildStdioConfig(
  entry: Record<string, unknown>,
  errors: (name: string, problem: string) => void,
  name: string,
): ExternalServerConfig | undefined {
  if (typeof entry.command !== 'string' || entry.command.trim() === '') {
    errors(name, 'stdio server requires a non-empty "command"');
    return undefined;
  }
  if (entry.args !== undefined && !Array.isArray(entry.args)) {
    errors(name, '"args" must be an array');
    return undefined;
  }
  if (
    entry.args !== undefined &&
    entry.args.some((a) => typeof a !== 'string')
  ) {
    errors(name, '"args" must contain only strings');
    return undefined;
  }
  const env = optionalStringRecord(entry.env);
  if (entry.env !== undefined && env === undefined) {
    errors(name, '"env" must be an object with string values');
    return undefined;
  }
  if (entry.cwd !== undefined && typeof entry.cwd !== 'string') {
    errors(name, '"cwd" must be a string');
    return undefined;
  }
  const timeout = optionalTimeout(entry.timeout, errors, name);
  if (!timeout.ok) return undefined;
  return {
    command: entry.command,
    ...(Array.isArray(entry.args) ? { args: entry.args as string[] } : {}),
    ...(env ? { env } : {}),
    ...(typeof entry.cwd === 'string' && entry.cwd ? { cwd: entry.cwd } : {}),
    ...(timeout.value !== undefined ? { timeout: timeout.value } : {}),
    exposure: 'direct',
  };
}

function buildHttpConfig(
  entry: Record<string, unknown>,
  errors: (name: string, problem: string) => void,
  name: string,
): ExternalServerConfig | undefined {
  if (typeof entry.url !== 'string' || entry.url.trim() === '') {
    errors(name, 'http server requires a non-empty "url"');
    return undefined;
  }
  const headers = optionalStringRecord(entry.headers);
  if (entry.headers !== undefined && headers === undefined) {
    errors(name, '"headers" must be an object with string values');
    return undefined;
  }
  const timeout = optionalTimeout(entry.timeout, errors, name);
  if (!timeout.ok) return undefined;
  return {
    url: entry.url,
    ...(headers ? { headers } : {}),
    ...(timeout.value !== undefined ? { timeout: timeout.value } : {}),
    exposure: 'direct',
  };
}

/**
 * Map the host-provided `mcpServers` payload onto Pi extension config
 * entries. Exposure is always forced to `direct`: codemode/deferred exposure
 * needs extensions the runner does not load, and a server whose tools are
 * unreachable would be a silent capability regression.
 */
export function parseExternalMcpServers(
  raw: string | undefined,
): ExternalMcpConfig {
  const config: ExternalMcpConfig = { servers: [], errors: [] };
  const pushError = (name: string, problem: string) => {
    config.errors.push(`mcp server "${name}": ${problem}`);
  };
  if (!raw || raw.trim() === '') return config;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    config.errors.push(
      `${MCP_SERVERS_ENV} is not valid JSON; no external MCP servers are loaded`,
    );
    return config;
  }
  if (!isRecord(parsed)) {
    config.errors.push(
      `${MCP_SERVERS_ENV} must be a JSON object; no external MCP servers are loaded`,
    );
    return config;
  }

  for (const [name, value] of Object.entries(parsed)) {
    if (!SERVER_NAME_PATTERN.test(name)) {
      pushError(
        name,
        'server name may only contain letters, digits, "_" and "-"',
      );
      continue;
    }
    if (!isRecord(value)) {
      pushError(name, 'entry must be an object');
      continue;
    }
    if (value.type === 'sse' || value.transport === 'sse') {
      pushError(
        name,
        'the legacy SSE transport is not supported; use a streamable HTTP "url"',
      );
      continue;
    }
    const built =
      value.url !== undefined ||
      value.type === 'http' ||
      value.type === 'streamable-http'
        ? buildHttpConfig(value, pushError, name)
        : buildStdioConfig(value, pushError, name);
    if (!built) continue;
    config.servers.push({ name, config: built, source: NAME_SOURCE });
  }
  return config;
}

/** Pi MCP extension bound to the Miniclaw env config source. */
export function createMiniclawMcpExtension(): ExtensionFactory {
  return createMcpExtension({
    loadConfig: () => {
      const loaded = parseExternalMcpServers(process.env[MCP_SERVERS_ENV]);
      for (const error of loaded.errors) {
        console.error(`[agent-runner:warn] external MCP skipped: ${error}`);
      }
      return {
        servers: loaded.servers,
        errors: loaded.errors,
        autoEnableCodemode: false,
      };
    },
  });
}
