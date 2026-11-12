import { describe, expect, test, vi } from 'vitest';
import {
  evaluateChannelAdmission,
  matchesChannelAccountAuthorization,
  matchesChannelPairTarget,
  parseChannelPairingCode,
  resolveAdmittedChannelRoute,
} from '../src/channel-admission.js';

describe('channel admission', () => {
  test('parses only a complete /pair command', () => {
    expect(parseChannelPairingCode('/pair abc123')).toBe('abc123');
    expect(parseChannelPairingCode(' /PAIR ABC123 ')).toBe('ABC123');
    expect(parseChannelPairingCode('/pair')).toBeNull();
    expect(parseChannelPairingCode('/pair one extra')).toBeNull();
    expect(parseChannelPairingCode('hello /pair abc123')).toBeNull();
  });

  test('denies an unpaired chat without calling registration', async () => {
    const onPairAttempt = vi.fn();
    await expect(
      evaluateChannelAdmission({
        jid: 'wechat:user#account:bot',
        chatName: 'User',
        text: 'hello',
        isChatAuthorized: () => false,
        onPairAttempt,
      }),
    ).resolves.toEqual({ kind: 'deny' });
    expect(onPairAttempt).not.toHaveBeenCalled();
  });

  test('consumes pairing before normal authorization', async () => {
    const onPairAttempt = vi.fn(async () => true);
    await expect(
      evaluateChannelAdmission({
        jid: 'wechat:1#account:bot',
        chatName: 'User',
        text: '/pair a1b2c3',
        isChatAuthorized: () => false,
        onPairAttempt,
      }),
    ).resolves.toEqual({ kind: 'paired' });
    expect(onPairAttempt).toHaveBeenCalledWith(
      'wechat:1#account:bot',
      'User',
      'a1b2c3',
    );
  });

  test('keeps legacy channels open only when no authorization callback exists', async () => {
    await expect(
      evaluateChannelAdmission({
        jid: 'legacy:chat',
        chatName: 'Legacy',
        text: 'hello',
      }),
    ).resolves.toEqual({ kind: 'allow' });
  });

  test('configured route resolver is authoritative and fails closed', () => {
    expect(resolveAdmittedChannelRoute('qq:source')).toEqual({
      targetJid: 'qq:source',
      routing: null,
    });
    expect(resolveAdmittedChannelRoute('qq:source', () => null)).toBeNull();
    expect(
      resolveAdmittedChannelRoute('qq:source', () => ({
        effectiveJid: 'web:workspace#agent:session',
        agentId: 'session',
      })),
    ).toEqual({
      targetJid: 'web:workspace#agent:session',
      routing: {
        effectiveJid: 'web:workspace#agent:session',
        agentId: 'session',
      },
    });
  });

  test('passes native context metadata to an authoritative resolver', () => {
    const resolver = vi.fn(() => ({
      effectiveJid: 'web:workspace',
      agentId: null,
    }));
    const context = { nativeContextType: 'thread', contextId: '42' };
    expect(
      resolveAdmittedChannelRoute('feishu:group#thread:42', resolver, context),
    ).toMatchObject({ targetJid: 'web:workspace' });
    expect(resolver).toHaveBeenCalledWith('feishu:group#thread:42', context);
  });

  test('rejects stale ownership rows and isolates two bots sharing one external chat id', () => {
    const base = {
      groupOwnerUserId: 'user-a',
      groupAccountId: 'bot-a',
      userId: 'user-a',
      expectedAccountOwnerUserId: 'user-a',
      allowLegacyUnscoped: false,
    };
    expect(
      matchesChannelAccountAuthorization({
        ...base,
        scopedAccountId: 'bot-a',
        expectedAccountId: 'bot-a',
      }),
    ).toBe(true);
    expect(
      matchesChannelAccountAuthorization({
        ...base,
        scopedAccountId: 'bot-b',
        expectedAccountId: 'bot-a',
      }),
    ).toBe(false);
    expect(
      matchesChannelAccountAuthorization({
        ...base,
        scopedAccountId: 'bot-a',
        groupAccountId: 'stale-bot',
        expectedAccountId: 'bot-a',
      }),
    ).toBe(false);
    expect(
      matchesChannelAccountAuthorization({
        ...base,
        scopedAccountId: 'bot-a',
        expectedAccountId: 'bot-a',
        expectedAccountOwnerUserId: 'user-b',
      }),
    ).toBe(false);
  });

  test('pairing cannot overwrite another account binding', () => {
    expect(
      matchesChannelPairTarget({
        scopedAccountId: 'bot-a',
        existingGroupAccountId: 'bot-a',
        expectedAccountId: 'bot-a',
      }),
    ).toBe(true);
    expect(
      matchesChannelPairTarget({
        scopedAccountId: 'bot-b',
        existingGroupAccountId: 'bot-b',
        expectedAccountId: 'bot-a',
      }),
    ).toBe(false);
    expect(
      matchesChannelPairTarget({
        scopedAccountId: 'bot-a',
        existingGroupAccountId: 'stale-bot',
        expectedAccountId: 'bot-a',
      }),
    ).toBe(false);
  });
});
