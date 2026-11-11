import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

/**
 * Turn observability configuration (task AB).
 *
 * The observer pipeline (turn-observer + recall-judge) is default-off and a
 * missing config file means the whole chain is a no-op — zero database writes,
 * zero stream taps. Two channels, same precedence as auto-memory:
 *
 *   1. CKQCLAW_OBSERVABILITY_* env vars (per-field override)
 *   2. data/config/observability.json
 *      { enabled, contentMode: 'full' | 'metadata', judge: { enabled } }
 *   3. Built-in default: disabled
 *
 * `full` stores redacted conversation text (host redactLogMessage); `metadata`
 * stores zero conversation text — metrics columns only.
 */

export interface ObservabilityConfig {
  enabled: boolean;
  contentMode: 'full' | 'metadata';
  judge: { enabled: boolean };
}

const CONFIG_FILE = path.join(DATA_DIR, 'config', 'observability.json');

const DEFAULT_CONFIG: ObservabilityConfig = {
  enabled: false,
  contentMode: 'metadata',
  judge: { enabled: false },
};

function parseBoolean(raw: unknown): boolean | undefined {
  if (raw === true || raw === 'true' || raw === 1 || raw === '1') return true;
  if (raw === false || raw === 'false' || raw === 0 || raw === '0')
    return false;
  return undefined;
}

function sanitizeConfig(raw: unknown): ObservabilityConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_CONFIG };
  }
  const value = raw as Record<string, unknown>;
  const enabled = parseBoolean(value.enabled);
  const contentMode =
    value.contentMode === 'full' || value.contentMode === 'metadata'
      ? value.contentMode
      : undefined;
  const judgeRaw =
    value.judge &&
    typeof value.judge === 'object' &&
    !Array.isArray(value.judge)
      ? (value.judge as Record<string, unknown>)
      : {};
  const judgeEnabled = parseBoolean(judgeRaw.enabled);

  const config: ObservabilityConfig = {
    enabled: enabled ?? false,
    contentMode: contentMode ?? DEFAULT_CONFIG.contentMode,
    judge: { enabled: judgeEnabled ?? false },
  };
  if (
    config.enabled &&
    (value.enabled === undefined ||
      enabled === undefined ||
      value.contentMode === undefined ||
      (value.judge !== undefined && judgeEnabled === undefined))
  ) {
    logger.warn(
      'observability config has invalid values — invalid fields fell back to safe defaults',
    );
  }
  return config;
}

let cached: { config: ObservabilityConfig; loadedAt: number } | null = null;

export function getObservabilityConfig(): ObservabilityConfig {
  if (cached && Date.now() - cached.loadedAt < 30_000) return cached.config;

  let config = { ...DEFAULT_CONFIG };
  try {
    const fileRaw = fs.readFileSync(CONFIG_FILE, 'utf8');
    config = sanitizeConfig(JSON.parse(fileRaw));
  } catch {
    // Absent file — the pipeline stays off.
  }

  // Env overrides win per field so an operator can flip observability on for
  // one run without rewriting the file channel.
  const envEnabled = parseBoolean(process.env.CKQCLAW_OBSERVABILITY_ENABLED);
  if (envEnabled !== undefined) config.enabled = envEnabled;
  const envContentMode = process.env.CKQCLAW_OBSERVABILITY_CONTENT_MODE;
  if (envContentMode === 'full' || envContentMode === 'metadata') {
    config.contentMode = envContentMode;
  }
  const envJudge = parseBoolean(
    process.env.CKQCLAW_OBSERVABILITY_JUDGE_ENABLED,
  );
  if (envJudge !== undefined) config.judge = { enabled: envJudge };

  cached = { config, loadedAt: Date.now() };
  return config;
}

/** Test hook. */
export function resetObservabilityConfigCache(): void {
  cached = null;
}
