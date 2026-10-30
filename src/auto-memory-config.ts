import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

/**
 * Auto-memory (mem0) configuration — host side.
 *
 * The auto layer captures episodic knowledge per workspace; Workspace Memory
 * v2 remains the curated source of truth. The sidecar needs OpenAI-compatible
 * endpoints for its LLM (fact extraction) and embedder (Anthropic offers no
 * embeddings), so the feature is inactive until an endpoint pair is provided:
 *
 *   1. MINICLAW_AUTO_MEMORY env var (JSON)
 *   2. data/config/auto-memory.json
 *   3. Built-in default: disabled (tools report "unavailable" cleanly).
 *
 * Endpoints never leave the host process: they feed only the host-owned
 * sidecar (auto-memory-sidecar-manager); runners receive a bare enable
 * flag over the stdin bootstrap and reach the sidecar via file IPC.
 * Per-workspace enable flags land with the workspace settings UI.
 */

export interface AutoMemoryEndpointConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AutoMemoryHostConfig {
  enabled: boolean;
  llm?: AutoMemoryEndpointConfig;
  embedder?: AutoMemoryEndpointConfig;
}

const CONFIG_FILE = path.join(DATA_DIR, 'config', 'auto-memory.json');

function endpointFrom(raw: unknown): AutoMemoryEndpointConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.baseUrl !== 'string' ||
    !/^https?:\/\//i.test(value.baseUrl) ||
    typeof value.apiKey !== 'string' ||
    value.apiKey.length === 0 ||
    typeof value.model !== 'string' ||
    value.model.length === 0
  ) {
    return undefined;
  }
  return {
    baseUrl: value.baseUrl,
    apiKey: value.apiKey,
    model: value.model,
  };
}

function sanitizeConfig(raw: unknown): AutoMemoryHostConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { enabled: false };
  }
  const value = raw as Record<string, unknown>;
  const llm = endpointFrom(value.llm);
  const embedder = endpointFrom(value.embedder);
  // Both endpoints are required: extraction and embedding are inseparable.
  const usable = Boolean(llm && embedder);
  if (!usable && (value.enabled === true || llm || embedder)) {
    logger.warn(
      'auto-memory endpoints incomplete (need llm + embedder with baseUrl/apiKey/model) — auto memory stays disabled',
    );
  }
  return {
    enabled: usable && value.enabled !== false,
    ...(llm ? { llm } : {}),
    ...(embedder ? { embedder } : {}),
  };
}

let cached: { config: AutoMemoryHostConfig; loadedAt: number } | null = null;

export function getAutoMemoryHostConfig(): AutoMemoryHostConfig {
  if (cached && Date.now() - cached.loadedAt < 30_000) return cached.config;

  let config: AutoMemoryHostConfig = { enabled: false };
  const envRaw = process.env.MINICLAW_AUTO_MEMORY;
  if (envRaw) {
    try {
      config = sanitizeConfig(JSON.parse(envRaw));
    } catch (error) {
      logger.warn(
        { err: error },
        'MINICLAW_AUTO_MEMORY is not valid JSON — auto memory stays disabled',
      );
    }
  } else {
    try {
      const fileRaw = fs.readFileSync(CONFIG_FILE, 'utf8');
      config = sanitizeConfig(JSON.parse(fileRaw));
    } catch {
      // Absent file — auto memory stays disabled.
    }
  }
  cached = { config, loadedAt: Date.now() };
  return config;
}

/** Test hook. */
export function resetAutoMemoryConfigCache(): void {
  cached = null;
}
