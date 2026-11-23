/**
 * Durable WeChat iLink context tokens (ISSUE-19).
 *
 * iLink only lets a bot message a user with the `context_token` from that
 * user's latest inbound message. The connection caches it in memory, so a
 * restart used to leave every proactive send (outbox retries, scheduled
 * pushes) failing until the user wrote again. The latest token per user is
 * now kept in the channel account's encrypted secret as one JSON string.
 *
 * Tokens are bound to the bot identity: a QR re-login merges into the same
 * secret, and a token issued to another bot must never be replayed.
 */

/** At most this many users are kept, most recently written first. */
export const WECHAT_CONTEXT_TOKEN_LIMIT = 200;

interface StoredToken {
  token: string;
  updatedAt: string;
}

interface StoredTokens {
  botId: string;
  tokens: Record<string, StoredToken>;
}

function readStored(raw: string | undefined): StoredTokens | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.botId !== 'string') return null;
    if (!record.tokens || typeof record.tokens !== 'object') return null;
    const tokens: Record<string, StoredToken> = {};
    for (const [userId, value] of Object.entries(
      record.tokens as Record<string, unknown>,
    )) {
      const entry = value as Partial<StoredToken> | null;
      if (
        entry &&
        typeof entry.token === 'string' &&
        entry.token &&
        typeof entry.updatedAt === 'string'
      ) {
        tokens[userId] = { token: entry.token, updatedAt: entry.updatedAt };
      }
    }
    return { botId: record.botId, tokens };
  } catch {
    return null;
  }
}

/** Tokens usable by `botId`; anything corrupt or foreign yields `{}`. */
export function parseWeChatContextTokens(
  raw: string | undefined,
  botId: string | undefined,
): Record<string, string> {
  const stored = readStored(raw);
  if (!stored || !botId || stored.botId !== botId) return {};
  return Object.fromEntries(
    Object.entries(stored.tokens).map(([userId, entry]) => [
      userId,
      entry.token,
    ]),
  );
}

/**
 * Merge one user's latest token into the stored value. Returns the previous
 * string unchanged when the token is already current, so callers can skip
 * the secret write.
 */
export function serializeWeChatContextTokens(
  botId: string,
  raw: string | undefined,
  update: { userId: string; token: string; now?: string },
): string {
  const stored = readStored(raw);
  const tokens = stored?.botId === botId ? { ...stored.tokens } : {};
  if (raw && tokens[update.userId]?.token === update.token) return raw;
  tokens[update.userId] = {
    token: update.token,
    updatedAt: update.now ?? new Date().toISOString(),
  };
  const kept = Object.entries(tokens)
    .sort(([, a], [, b]) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, WECHAT_CONTEXT_TOKEN_LIMIT);
  return JSON.stringify({ botId, tokens: Object.fromEntries(kept) });
}

/**
 * Cache a token and report it when it changed. Persistence is best effort:
 * a failing callback must never break inbound message handling.
 */
export function rememberWeChatContextToken(
  cache: Map<string, string>,
  userId: string,
  token: string,
  onChange?: (userId: string, token: string) => void,
): void {
  const previous = cache.get(userId);
  cache.set(userId, token);
  if (previous === token || !onChange) return;
  try {
    onChange(userId, token);
  } catch {
    // The in-memory cache is already updated; the next token retries the write.
  }
}
