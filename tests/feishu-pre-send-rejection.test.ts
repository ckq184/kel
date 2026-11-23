/**
 * ISSUE-21 A1：飞书能力变更（send_card、add_reaction 等）经 outbox 投递，
 * `execute` 链上“机器人未连接”的三处拒绝都发生在调用飞书之前，必须抛
 * ChannelPreSendRejection，让 outbox 行落 failed，而不是当作结果不确定的
 * uncertain 封住整个 turn。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-pre-send-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config.js')>()),
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));

const db = await import('../src/db.js');
const store = await import('../src/channel-reliability-store.js');
const { deliverFeishuCapabilityMutation } =
  await import('../src/feishu-capability-outbox.js');
const { ChannelPreSendRejection } = await import('../src/channel-errors.js');
const { IMConnectionManager } = await import('../src/im-manager.js');
const { createFeishuChannel } = await import('../src/im-channel.js');
const { createFeishuConnection } = await import('../src/feishu.js');

const route = {
  provider: 'feishu',
  accountId: 'bot-pre-send',
  sourceJid: 'feishu:chat-pre-send#account:bot-pre-send',
  chatId: 'chat-pre-send',
};
const context = {} as never;
const request = {
  operation: 'add_reaction' as const,
  params: { messageId: 'om_target', emojiType: 'THUMBSUP' },
};
const config = { appId: 'app-pre-send', appSecret: 'secret-pre-send' };

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Feishu capability pre-send rejections', () => {
  test('IM manager without a connected Feishu bot rejects before contacting Feishu', async () => {
    const manager = new IMConnectionManager();
    await expect(
      manager.executeFeishuCapability(route.sourceJid, context, request),
    ).rejects.toBeInstanceOf(ChannelPreSendRejection);
  });

  test('a Feishu channel that never connected rejects before contacting Feishu', async () => {
    const channel = createFeishuChannel(config);
    await expect(
      channel.executeFeishuCapability!(context, request),
    ).rejects.toBeInstanceOf(ChannelPreSendRejection);
  });

  test('a Feishu connection without a client rejects before contacting Feishu', async () => {
    const connection = createFeishuConnection(config);
    await expect(
      connection.executeCapability(context, request),
    ).rejects.toBeInstanceOf(ChannelPreSendRejection);
  });

  test('the mutation outbox row fails instead of fencing the turn as uncertain', async () => {
    const run = store.createChannelTurnRun({
      ...route,
      idempotencyKey: 'feishu-pre-send-not-connected',
    }).run;
    const manager = new IMConnectionManager();

    const result = await deliverFeishuCapabilityMutation({
      ...route,
      turnRunId: run.id,
      requestId: 'not-connected-request',
      request,
      owner: 'not-connected-worker',
      execute: () =>
        manager.executeFeishuCapability(route.sourceJid, context, request),
    });

    expect(result.delivery.status).toBe('failed');
    expect(store.getUncertainChannelOutboxForTurn(run.id)).toBeUndefined();
  });
});
