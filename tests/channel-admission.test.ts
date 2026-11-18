import { describe, expect, test, vi } from 'vitest';
import {
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
