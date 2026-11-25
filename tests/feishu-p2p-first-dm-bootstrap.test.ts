/**
 * 回归：飞书首次私聊注册失败。
 *
 * im-manager 的 scopeConnectOpts 包装器对“解析不到路由”抛 ChannelRouteRejectedError
 * （契约，见 im-manager-channel-accounts.test.ts），而 feishu.ts 的 P2P 引导探测
 * 曾按“返回 falsy”编写，结果未注册私聊的第一条消息在探测处抛错，
 * onNewChat / onP2pSender 永远不会执行，消息被 channel_inbox 无限重试。
 *
 * 这里用真实 IMConnectionManager 包装 + 真实 feishu 处理器（仅 mock Lark SDK）
 * 复现真实账号连接的接线，不依赖源码字符串。
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-p2p-bootstrap-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

const controls = vi.hoisted(() => ({
  dispatchers: [] as Array<Record<string, (data: any) => Promise<unknown>>>,
  messageCreate: vi.fn(),
  messageReply: vi.fn(),
}));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
  DATA_DIR: tmpDir,
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  AppType: { SelfBuild: 'SelfBuild' },
  LoggerLevel: { info: 'info' },
  Client: class {
    request = vi.fn().mockResolvedValue({
      bot: { open_id: 'ou_bot', app_name: 'P2P Bootstrap Bot' },
    });
    im = {
      v1: {
        chat: {
          list: vi.fn().mockResolvedValue({
            data: { items: [], has_more: false },
          }),
        },
        message: {
          list: vi.fn().mockResolvedValue({
            data: { items: [], has_more: false },
          }),
          get: vi.fn().mockResolvedValue({ data: { items: [] } }),
          create: controls.messageCreate,
        },
        messageReaction: {
          create: vi.fn().mockResolvedValue({
            code: 0,
            data: { reaction_id: 'reaction_1' },
          }),
          delete: vi.fn().mockResolvedValue({ code: 0 }),
        },
      },
      message: { reply: controls.messageReply },
      messageReaction: {
        create: vi.fn().mockResolvedValue({ code: 0 }),
        delete: vi.fn().mockResolvedValue({ code: 0 }),
      },
      messageResource: { get: vi.fn() },
    };
  },
  EventDispatcher: class {
    private readonly handlers: Record<string, (data: any) => Promise<unknown>> =
      {};
    constructor() {
      controls.dispatchers.push(this.handlers);
    }
    register(input: Record<string, (data: any) => Promise<unknown>>) {
      Object.assign(this.handlers, input);
      return this;
    }
  },
  WSClient: class {
    async start() {}
    async close() {}
  },
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { IMConnectionManager } = await import('../src/im-manager.js');
const { createFeishuChannel } = await import('../src/im-channel.js');
const { recordChannelInbox } =
  await import('../src/channel-reliability-store.js');

const OWNER_ID = 'p2p-bootstrap-owner';
const ACCOUNT_ID = 'p2p-bootstrap-account';
const WORKSPACE_JID = 'web:p2p-bootstrap-workspace';
const SENDER_OPEN_ID = 'ou_first_dm_user';

const managers: Array<InstanceType<typeof IMConnectionManager>> = [];

beforeAll(() => {
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: OWNER_ID,
    username: OWNER_ID,
    password_hash: 'test',
    display_name: OWNER_ID,
    role: 'member',
    status: 'active',
    created_at: now,
    updated_at: now,
  });
  db.createChannelAccount({
    id: ACCOUNT_ID,
    owner_user_id: OWNER_ID,
    provider: 'feishu',
    name: 'P2P bootstrap account',
    secret_ref: 'test-secret-ref',
    enabled: true,
    auth_status: 'authorized',
  });
  db.setRegisteredGroup(WORKSPACE_JID, {
    name: 'P2P Bootstrap Workspace',
    folder: 'p2p-bootstrap-workspace',
    added_at: now,
    created_by: OWNER_ID,
  });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  controls.dispatchers.length = 0;
  controls.messageCreate.mockReset().mockResolvedValue({
    code: 0,
    data: { message_id: 'om_reply' },
  });
  controls.messageReply.mockReset().mockResolvedValue({
    code: 0,
    data: { message_id: 'om_reply' },
  });
});

afterEach(async () => {
  await Promise.allSettled(
    managers.splice(0).map((manager) => manager.disconnectAll()),
  );
});

function p2pEvent(chatId: string, messageId: string, text: string) {
  return {
    message: {
      chat_id: chatId,
      message_id: messageId,
      create_time: String(Date.now() - 30_000),
      message_type: 'text',
      content: JSON.stringify({ text }),
      chat_type: 'p2p',
    },
    sender: {
      sender_id: { open_id: SENDER_OPEN_ID },
      sender_type: 'user',
      sender_name: 'First DM User',
    },
  };
}

/**
 * Mirrors index.ts: an unregistered chat resolves to null; a registered chat
 * resolves through its workspace binding; a binding to a vanished workspace is
 * stale and resolves to null.
 */
function resolveFromDb(jid: string) {
  const group = db.getRegisteredGroup(jid);
  if (!group?.target_main_jid) return null;
  if (!db.getRegisteredGroup(group.target_main_jid)) return null;
  return { effectiveJid: group.target_main_jid, agentId: null };
}

async function connectAccount(
  overrides: Partial<import('../src/im-channel.js').IMChannelConnectOpts> = {},
) {
  const onNewChat = vi.fn((jid: string, name: string) => {
    if (db.getRegisteredGroup(jid)) return; // idempotent, like buildOnNewChat
    db.setRegisteredGroup(jid, {
      name,
      folder: `p2p-${jid.replace(/[^a-z0-9]/gi, '-').slice(0, 40)}`,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      channel_account_id: ACCOUNT_ID,
      target_main_jid: WORKSPACE_JID,
    });
  });
  const onP2pSender = vi.fn();
  const onFollowUpMessage = vi.fn(() => ({ disposition: 'started' as const }));
  const manager = new IMConnectionManager();
  managers.push(manager);
  const dispatcherIndex = controls.dispatchers.length;
  const connected = await manager.connectChannel(
    OWNER_ID,
    'feishu',
    createFeishuChannel({
      appId: 'app_p2p_bootstrap',
      appSecret: 'secret',
      channelAccountId: ACCOUNT_ID,
    }),
    {
      onReady: vi.fn(),
      onNewChat,
      onP2pSender,
      onFollowUpMessage,
      resolveEffectiveChatJid: resolveFromDb,
      ...overrides,
    },
    ACCOUNT_ID,
  );
  expect(connected).toBe(true);
  const handler =
    controls.dispatchers[dispatcherIndex]?.['im.message.receive_v1'];
  expect(handler).toBeTypeOf('function');
  return { handler, onNewChat, onP2pSender, onFollowUpMessage };
}

function inboxOf(messageId: string, chatId: string) {
  return recordChannelInbox({
    provider: 'feishu',
    accountId: ACCOUNT_ID,
    externalMessageId: messageId,
    sourceJid: `feishu:${chatId}`,
    chatId,
    status: 'queued',
  }).item;
}

describe('Feishu first P2P DM bootstrap through the real IM manager wrapper', () => {
  test('first message from an unknown P2P chat registers the chat instead of failing admission', async () => {
    const chatId = 'oc_first_dm_register';
    const scopedJid = `feishu:${chatId}#account:${ACCOUNT_ID}`;
    expect(db.getRegisteredGroup(scopedJid)).toBeUndefined();
    const connected = await connectAccount();

    await connected.handler(p2pEvent(chatId, 'om_first_dm_register', '你好'));

    const inbox = inboxOf('om_first_dm_register', chatId);
    expect(inbox.error).toBeNull();
    expect(inbox.status).toBe('processed');
    expect(connected.onNewChat).toHaveBeenCalledWith(scopedJid, '飞书私聊');
    expect(db.getRegisteredGroup(scopedJid)?.target_main_jid).toBe(
      WORKSPACE_JID,
    );
    expect(connected.onFollowUpMessage).toHaveBeenCalledTimes(1);
  });

  test('the same first message teaches the bot owner through onP2pSender', async () => {
    const chatId = 'oc_first_dm_owner';
    const connected = await connectAccount();

    await connected.handler(p2pEvent(chatId, 'om_first_dm_owner', '你好'));

    expect(connected.onP2pSender).toHaveBeenCalledWith(SENDER_OPEN_ID);
    expect(inboxOf('om_first_dm_owner', chatId).status).toBe('processed');
  });

  test('a legitimately rejected route is terminated as binding_rejected instead of being retried forever, and the bootstrap does not swallow it', async () => {
    const chatId = 'oc_stale_binding';
    const scopedJid = `feishu:${chatId}#account:${ACCOUNT_ID}`;
    // Registered private chat whose binding points at a workspace that no
    // longer exists: the resolver legitimately rejects it.
    db.setRegisteredGroup(scopedJid, {
      name: 'Stale binding',
      folder: 'p2p-stale-binding',
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      channel_account_id: ACCOUNT_ID,
      target_main_jid: 'web:vanished-workspace',
    });
    const connected = await connectAccount();

    await connected.handler(p2pEvent(chatId, 'om_stale_binding', '你好'));

    // Terminal: the durable Inbox must not keep a configuration-level
    // rejection queued, and the chat must not be told "will retry" every 5s.
    const inbox = inboxOf('om_stale_binding', chatId);
    expect(inbox.status).toBe('ignored');
    expect(inbox.error).toBe('binding_rejected');
    expect(connected.onFollowUpMessage).not.toHaveBeenCalled();
    expect(controls.messageCreate).not.toHaveBeenCalled();
    expect(controls.messageReply).not.toHaveBeenCalled();
    expect(db.getRegisteredGroup(scopedJid)?.target_main_jid).toBe(
      'web:vanished-workspace',
    );

    // A redelivery of the same message hits the terminal row and is a no-op.
    await connected.handler(p2pEvent(chatId, 'om_stale_binding', '你好'));
    expect(inboxOf('om_stale_binding', chatId).status).toBe('ignored');
    expect(connected.onFollowUpMessage).not.toHaveBeenCalled();
    expect(controls.messageCreate).not.toHaveBeenCalled();
  });

  test('a rejection that is not the resolver verdict (paused or disabled connection) is still retried, never terminated', async () => {
    const chatId = 'oc_inactive_not_terminal';
    db.setRegisteredGroup(`feishu:${chatId}#account:${ACCOUNT_ID}`, {
      name: 'Bound private chat',
      folder: 'p2p-inactive-not-terminal',
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      channel_account_id: ACCOUNT_ID,
      target_main_jid: WORKSPACE_JID,
    });
    const connected = await connectAccount();
    db.updateChannelAccount(ACCOUNT_ID, OWNER_ID, { enabled: false });
    try {
      await connected.handler(
        p2pEvent(chatId, 'om_inactive_not_terminal', '你好'),
      );
    } finally {
      db.updateChannelAccount(ACCOUNT_ID, OWNER_ID, { enabled: true });
    }

    // The route itself is perfectly valid; only the connection is inactive.
    const inbox = inboxOf('om_inactive_not_terminal', chatId);
    expect(inbox.status).toBe('queued');
    expect(inbox.error).toContain('Channel binding resolver rejected route');
    expect(connected.onFollowUpMessage).not.toHaveBeenCalled();
  });

  test('a disabled account neither registers the chat nor learns the owner', async () => {
    const chatId = 'oc_disabled_account';
    const scopedJid = `feishu:${chatId}#account:${ACCOUNT_ID}`;
    const connected = await connectAccount();
    db.updateChannelAccount(ACCOUNT_ID, OWNER_ID, { enabled: false });
    try {
      await connected.handler(p2pEvent(chatId, 'om_disabled_account', '你好'));
    } finally {
      db.updateChannelAccount(ACCOUNT_ID, OWNER_ID, { enabled: true });
    }

    const inbox = inboxOf('om_disabled_account', chatId);
    expect(inbox.status).toBe('queued');
    expect(inbox.error).toContain('Channel binding resolver rejected route');
    expect(connected.onNewChat).not.toHaveBeenCalled();
    expect(connected.onP2pSender).not.toHaveBeenCalled();
    expect(db.getRegisteredGroup(scopedJid)).toBeUndefined();
  });

  test('only ChannelRouteRejectedError counts as "not registered yet"; other resolver failures still surface', async () => {
    const chatId = 'oc_resolver_crash';
    const connected = await connectAccount({
      resolveEffectiveChatJid: () => {
        throw new Error('resolver exploded');
      },
    });

    await connected.handler(p2pEvent(chatId, 'om_resolver_crash', '你好'));

    const inbox = inboxOf('om_resolver_crash', chatId);
    expect(inbox.status).toBe('queued');
    expect(inbox.error).toContain('resolver exploded');
    expect(connected.onNewChat).not.toHaveBeenCalled();
    expect(connected.onP2pSender).not.toHaveBeenCalled();
  });
});

describe('Feishu durable retry feedback', () => {
  /** Retry notices the bot sent to one chat (text replies use message.create). */
  function retryNoticesTo(chatId: string): number {
    return controls.messageCreate.mock.calls.filter(([request]) => {
      const data = (request as { data?: { receive_id?: string } }).data;
      return (
        data?.receive_id === chatId &&
        JSON.stringify(request).includes('消息处理暂时失败')
      );
    }).length;
  }

  test('a persistently failing message is announced once, not on every durable retry', async () => {
    const chatId = 'oc_retry_notice_once';
    const connected = await connectAccount({
      resolveEffectiveChatJid: () => {
        throw new Error('resolver exploded');
      },
    });

    vi.useFakeTimers();
    try {
      await connected.handler(p2pEvent(chatId, 'om_retry_notice_once', '你好'));
      expect(inboxOf('om_retry_notice_once', chatId).attempt).toBe(1);
      expect(retryNoticesTo(chatId)).toBe(1);

      // Two further recovery passes re-run the same durable message with its
      // original 'ws' source; the user was already told it will be retried.
      await vi.advanceTimersByTimeAsync(6_000);
      await vi.advanceTimersByTimeAsync(6_000);

      const inbox = inboxOf('om_retry_notice_once', chatId);
      expect(inbox.status).toBe('queued');
      expect(inbox.attempt).toBeGreaterThanOrEqual(3);
      expect(inbox.error).toContain('resolver exploded');
      expect(retryNoticesTo(chatId)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
