import { createHash } from 'node:crypto';

export interface EffectiveMcpManifest {
  schemaVersion: 1;
  hash: string;
  serverIds: string[];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

/** Hash the exact resolved runtime map without exposing commands or secrets. */
export function buildEffectiveMcpManifest(
  servers: Record<string, Record<string, unknown>>,
): EffectiveMcpManifest {
  const serverIds = Object.keys(servers).sort();
  const definitions = Object.fromEntries(
    serverIds.map((id) => [id, canonicalize(servers[id])]),
  );
  return {
    schemaVersion: 1,
    hash: createHash('sha256')
      .update(JSON.stringify({ schemaVersion: 1, definitions }), 'utf8')
      .digest('hex'),
    serverIds,
  };
}
