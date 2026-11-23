/**
 * ISSUE-19 T2：微信 context_token 持久化（用户拍板：存进渠道账号加密
 * secret，与 ilinkBotId 绑定，换号即作废）。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { Dispatcher } from 'undici';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const tokens = await import('../src/wechat-context-tokens.js');
const { createWeChatConnection } = await import('../src/wechat.js');

describe('context token serialization', () => {
  test('round-trips tokens bound to the bot identity', () => {
    const raw = tokens.serializeWeChatContextTokens('bot-a', undefined, {
      userId: 'user-1',
      token: 'ctx-1',
      now: '2026-11-23T00:00:00.000Z',
    });
    expect(tokens.parseWeChatContextTokens(raw, 'bot-a')).toEqual({
      'user-1': 'ctx-1',
    });
  });

  test('ignores tokens written for a different bot, or a corrupt value', () => {
    const raw = tokens.serializeWeChatContextTokens('bot-a', undefined, {
      userId: 'user-1',
      token: 'ctx-1',
    });
    expect(tokens.parseWeChatContextTokens(raw, 'bot-b')).toEqual({});
    expect(tokens.parseWeChatContextTokens('{not json', 'bot-a')).toEqual({});
    expect(tokens.parseWeChatContextTokens(undefined, 'bot-a')).toEqual({});
    expect(
      tokens.parseWeChatContextTokens(
        JSON.stringify({ botId: 'bot-a', tokens: { u: { token: 7 } } }),
        'bot-a',
      ),
    ).toEqual({});
  });

  test('updates an existing user and drops entries of another bot', () => {
    const first = tokens.serializeWeChatContextTokens('bot-a', undefined, {
      userId: 'user-1',
      token: 'old',
    });
    const switched = tokens.serializeWeChatContextTokens('bot-b', first, {
      userId: 'user-2',
      token: 'new',
    });
    expect(tokens.parseWeChatContextTokens(switched, 'bot-b')).toEqual({
      'user-2': 'new',
    });
    const updated = tokens.serializeWeChatContextTokens('bot-b', switched, {
      userId: 'user-2',
      token: 'newer',
    });
    expect(tokens.parseWeChatContextTokens(updated, 'bot-b')).toEqual({
      'user-2': 'newer',
    });
  });

  test('keeps only the most recently written users', () => {
    let raw: string | undefined;
    for (let i = 0; i < 205; i++) {
      raw = tokens.serializeWeChatContextTokens('bot-a', raw, {
        userId: `user-${i}`,
        token: `ctx-${i}`,
        now: new Date(Date.UTC(2026, 10, 23, 0, 0, i)).toISOString(),
      });
    }
    const parsed = tokens.parseWeChatContextTokens(raw, 'bot-a');
    expect(Object.keys(parsed)).toHaveLength(tokens.WECHAT_CONTEXT_TOKEN_LIMIT);
    expect(parsed['user-0']).toBeUndefined();
    expect(parsed['user-204']).toBe('ctx-204');
  });
});

describe('rememberWeChatContextToken', () => {
  test('notifies only when the token changes and survives callback errors', () => {
    const cache = new Map<string, string>();
    const onChange = vi.fn();
    tokens.rememberWeChatContextToken(cache, 'user-1', 'ctx-1', onChange);
    tokens.rememberWeChatContextToken(cache, 'user-1', 'ctx-1', onChange);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('user-1', 'ctx-1');

    const failing = vi.fn(() => {
      throw new Error('disk full');
    });
    expect(() =>
      tokens.rememberWeChatContextToken(cache, 'user-1', 'ctx-2', failing),
    ).not.toThrow();
    expect(cache.get('user-1')).toBe('ctx-2');
  });

  test('the inbound processor caches tokens through the helper', () => {
    const source = fs
      .readFileSync(
        path.join(__dirname, '..', 'src', 'wechat-inbound.ts'),
        'utf8',
      )
      .replace(/\r\n/g, '\n');
    expect(source).toMatch(
      /rememberWeChatContextToken\(\s*contextTokenCache,\s*fromUserId,\s*msg\.context_token,\s*opts\.onContextToken,?\s*\)/,
    );
    expect(source).not.toMatch(/contextTokenCache\.set\(/);
  });
});

function waitUntilAborted(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const abort = () =>
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
  });
}

describe('connection seeding', () => {
  test('a new connection can reply with a persisted token before any inbound', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const fetchMock = vi.fn(
      async (url: string, init?: { body?: unknown; signal?: AbortSignal }) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        calls.push({ url, body });
        if (url.includes('getupdates')) return waitUntilAborted(init?.signal);
        return Response.json({ ret: 0 });
      },
    );
    const connection = createWeChatConnection(
      {
        botToken: 'bot-token',
        ilinkBotId: 'bot-a',
        contextTokens: { 'user-1': 'persisted-ctx' },
      },
      {
        fetch: fetchMock as unknown as typeof fetch,
        createDispatcher: () =>
          ({ close: async () => undefined }) as unknown as Dispatcher,
      },
    );
    await connection.connect({ onNewChat: vi.fn() });
    await connection.sendMessage('user-1', 'after restart');
    const send = calls.find((c) => c.url.includes('sendmessage'));
    expect(send?.body.msg).toMatchObject({
      to_user_id: 'user-1',
      context_token: 'persisted-ctx',
    });
    await connection.disconnect();
  });
});
