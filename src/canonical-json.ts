/**
 * Canonical JSON normalization shared by the host and the agent runner.
 *
 * This is the single source of truth. Build step copies this file to:
 *   - src/canonical-json.ts
 *   - container/agent-runner/src/canonical-json.ts
 *
 * DO NOT edit the copies directly -- edit this file and run `make sync-types`.
 *
 * 签名一致性红线：本函数参与 Workspace Memory HMAC 签名（host 侧
 * workspace-memory-capability 与 runner 侧 workspace-memory-auth 各自构造
 * payload 后 HMAC），函数体必须与收敛前实现逐字相同（ISSUE-11 B10 的收敛为
 * 纯移动，非重写）。
 */
export function normalizeForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === undefined ? null : normalizeForCanonicalJson(item),
    );
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .filter((key) => source[key] !== undefined)
        .map((key) => [key, normalizeForCanonicalJson(source[key])]),
    );
  }
  return value;
}
