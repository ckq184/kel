/**
 * ISSUE-19 T1：渠道抛 ChannelPreSendRejection 时，deliverChannelOutboxItem
 * 把它当确定拒绝：行落 failed，不落 uncertain，同 turn 的后续行不被围栏。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-send-rejection-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const store = await import('../src/channel-reliability-store.js');
const delivery = await import('../src/channel-outbox-delivery.js');
const { ChannelPreSendRejection, ChannelProviderRejection } =
  await import('../src/channel-errors.js');

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

const route = {
  provider: 'wechat',
  accountId: 'wechat-account',
  sourceJid: 'wechat:user-1@im.wechat#account:wechat-account',
  chatId: 'user-1@im.wechat',
  rootId: null,
  threadId: null,
};

describe('pre-send rejection in the outbox state machine', () => {
  test('a pre-send rejection fails the row instead of fencing the turn', async () => {
    const run = store.createChannelTurnRun({
      ...route,
      idempotencyKey: 'pre-send-rejection:turn',
    }).run;
    const rejected = await delivery.deliverChannelOutboxItem({
      ...route,
      turnRunId: run.id,
      ordinal: 0,
      kind: 'text',
      payload: { text: 'no token yet' },
      owner: 'test-owner',
      delivery: {
        mode: 'single',
        send: async () => {
          throw new ChannelPreSendRejection(
            'No context_token available for WeChat chat user-1',
          );
        },
      },
    });
    expect(rejected).toMatchObject({
      status: 'failed',
      error: 'No context_token available for WeChat chat user-1',
    });
    expect(store.getUncertainChannelOutboxForTurn(run.id)).toBeUndefined();

    // A later sibling of the same turn is not fenced.
    const sibling = await delivery.deliverChannelOutboxItem({
      ...route,
      turnRunId: run.id,
      ordinal: 1,
      kind: 'text',
      payload: { text: 'after token arrives' },
      owner: 'test-owner',
      delivery: {
        mode: 'single',
        send: async () => ({ providerMessageId: 'msg-1' }),
      },
    });
    expect(sibling.status).toBe('delivered');
  });

  test('a provider rejection (ISSUE-23) fails the row instead of fencing the turn', async () => {
    const run = store.createChannelTurnRun({
      ...route,
      idempotencyKey: 'provider-rejection:turn',
    }).run;
    const rejected = await delivery.deliverChannelOutboxItem({
      ...route,
      turnRunId: run.id,
      ordinal: 0,
      kind: 'text',
      payload: { text: 'session expired' },
      owner: 'test-owner',
      delivery: {
        mode: 'single',
        send: async () => {
          throw new ChannelProviderRejection('sendMessage failed: ret=-14');
        },
      },
    });
    expect(rejected).toMatchObject({
      status: 'failed',
      error: 'sendMessage failed: ret=-14',
    });
    expect(store.getUncertainChannelOutboxForTurn(run.id)).toBeUndefined();

    const sibling = await delivery.deliverChannelOutboxItem({
      ...route,
      turnRunId: run.id,
      ordinal: 1,
      kind: 'text',
      payload: { text: 'after re-login' },
      owner: 'test-owner',
      delivery: {
        mode: 'single',
        send: async () => ({ providerMessageId: 'msg-2' }),
      },
    });
    expect(sibling.status).toBe('delivered');
  });

  test('an ordinary error after sending still fences as uncertain', async () => {
    const run = store.createChannelTurnRun({
      ...route,
      idempotencyKey: 'pre-send-rejection:ordinary',
    }).run;
    const result = await delivery.deliverChannelOutboxItem({
      ...route,
      turnRunId: run.id,
      ordinal: 0,
      kind: 'text',
      payload: { text: 'ambiguous' },
      owner: 'test-owner',
      delivery: {
        mode: 'single',
        send: async () => {
          throw new Error('socket hang up');
        },
      },
    });
    expect(result.status).toBe('uncertain');
  });
});
