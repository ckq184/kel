import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const controls = vi.hoisted(() => ({
  feishuMessageCreate: vi.fn(),
  feishuMessageReply: vi.fn(),
  feishuImageCreate: vi.fn(),
  feishuFileCreate: vi.fn(),
  feishuChatList: vi.fn(),
  updateChatName: vi.fn(),
  updateRegisteredGroupAvatar: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  AppType: { SelfBuild: 'SelfBuild' },
  LoggerLevel: { info: 'info' },
  Client: class {
    request = vi.fn().mockResolvedValue({ bot: { open_id: 'ou_bot' } });
    im = {
      v1: {
        message: { create: controls.feishuMessageCreate },
        image: { create: controls.feishuImageCreate },
        file: { create: controls.feishuFileCreate },
        chat: { list: controls.feishuChatList },
      },
      message: { reply: controls.feishuMessageReply },
      messageReaction: {
        create: vi.fn().mockResolvedValue({ code: 0 }),
        delete: vi.fn().mockResolvedValue({ code: 0 }),
      },
    };
  },
  EventDispatcher: class {
    register() {
      return this;
    }
  },
  WSClient: class {
    async start() {}
    async close() {}
  },
}));

vi.mock('../src/db.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    updateChatName: controls.updateChatName,
    updateRegisteredGroupAvatar: controls.updateRegisteredGroupAvatar,
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
  createFeishuConnection,
  parseFeishuRouteTarget,
  resolveFeishuMessageAnchor,
} = await import('../src/feishu.js');

let cleanup: Array<() => Promise<void>> = [];

beforeEach(() => {
  cleanup = [];
  vi.clearAllMocks();
  controls.feishuMessageCreate.mockResolvedValue({
    code: 0,
    data: { message_id: 'om_1' },
  });
  controls.feishuMessageReply.mockResolvedValue({
    code: 0,
    data: { message_id: 'om_1' },
  });
  controls.feishuImageCreate.mockResolvedValue({
    image_key: 'img_1',
  });
  controls.feishuFileCreate.mockResolvedValue({
    file_key: 'file_1',
  });
  controls.feishuChatList.mockResolvedValue({
    data: {
      items: [
        {
          chat_id: 'oc_visible',
          name: '已加入的群',
          avatar: 'https://example.com/visible.png',
        },
        { chat_id: 'oc_unnamed' },
      ],
      has_more: false,
    },
  });
});

afterEach(async () => {
  await Promise.allSettled(cleanup.map((fn) => fn()));
});

async function connectedTransports() {
  const feishu = createFeishuConnection({ appId: 'app', appSecret: 'secret' });
  expect(await feishu.connect({ onReady: vi.fn() })).toBe(true);
  cleanup.push(() => feishu.stop());
  return { feishu };
}

describe('IM strict send acknowledgement', () => {
  test('Feishu native presentation uses post while default keeps interactive cards', async () => {
    const { feishu } = await connectedTransports();

    await expect(
      feishu.sendMessage('oc_1', '像真人一样发言', undefined, {
        presentation: 'native',
      }),
    ).resolves.toBeUndefined();

    expect(controls.feishuMessageCreate).toHaveBeenCalledOnce();
    expect(controls.feishuMessageCreate.mock.calls[0][0].data).toMatchObject({
      receive_id: 'oc_1',
      msg_type: 'post',
    });
    expect(
      JSON.parse(
        controls.feishuMessageCreate.mock.calls[0][0].data.content as string,
      ),
    ).toMatchObject({
      zh_cn: {
        content: [[{ tag: 'md', text: '像真人一样发言' }]],
      },
    });

    controls.feishuMessageCreate.mockClear();
    await expect(
      feishu.sendMessage('oc_1', '传统机器人回复'),
    ).resolves.toBeUndefined();

    expect(controls.feishuMessageCreate).toHaveBeenCalledOnce();
    expect(controls.feishuMessageCreate.mock.calls[0][0].data).toMatchObject({
      receive_id: 'oc_1',
      msg_type: 'interactive',
    });
  });

  test('Feishu chat inventory reports every visible chat to registration', async () => {
    const feishu = createFeishuConnection({
      appId: 'app',
      appSecret: 'secret',
    });
    const onNewChat = vi.fn();
    expect(
      await feishu.connect({
        onReady: vi.fn(),
        onNewChat,
        normalizeIncomingJid: (jid) => `${jid}#account:secondary`,
      }),
    ).toBe(true);
    cleanup.push(() => feishu.stop());

    await feishu.syncGroups();

    expect(onNewChat).toHaveBeenNthCalledWith(
      1,
      'feishu:oc_visible',
      '已加入的群',
    );
    expect(onNewChat).toHaveBeenNthCalledWith(
      2,
      'feishu:oc_unnamed',
      '飞书聊天',
    );
    expect(controls.updateChatName).toHaveBeenCalledWith(
      'feishu:oc_visible#account:secondary',
      '已加入的群',
    );
    expect(controls.updateRegisteredGroupAvatar).toHaveBeenCalledWith(
      'feishu:oc_visible#account:secondary',
      'https://example.com/visible.png',
    );
  });

  test('all send methods reject while their transport is uninitialized', async () => {
    const feishu = createFeishuConnection({
      appId: 'app',
      appSecret: 'secret',
    });
    await expect(feishu.sendMessage('oc_1', 'hello')).rejects.toThrow(
      'not initialized',
    );
    await expect(
      feishu.sendImage('oc_1', Buffer.from('image'), 'image/png'),
    ).rejects.toThrow('not initialized');
    await expect(feishu.sendFile('oc_1', '/missing', 'a.txt')).rejects.toThrow(
      'not initialized',
    );
  });

  test('all send methods reject malformed provider targets', async () => {
    const { feishu } = await connectedTransports();

    await expect(feishu.sendMessage('', 'hello')).rejects.toThrow(
      'Invalid Feishu route target',
    );
    await expect(
      feishu.sendImage('oc_1#root:', Buffer.from('image'), 'image/png'),
    ).rejects.toThrow('Invalid Feishu route target');
    await expect(
      feishu.sendFile('oc_1#unknown:x', '/missing', 'a.txt'),
    ).rejects.toThrow('Invalid Feishu route target');
    await expect(
      feishu.sendImage(
        'oc_1#thread:omt_without_root',
        Buffer.from('image'),
        'image/png',
      ),
    ).rejects.toThrow('Invalid Feishu route target');
  });

  test('never resolves a bare group route to the latest message from another topic', () => {
    const bareGroup = parseFeishuRouteTarget('oc_group');
    expect(
      resolveFeishuMessageAnchor({
        target: bareGroup,
        chatType: 'group',
        lastMessageId: 'om_latest_message_in_topic_b',
      }),
    ).toBeUndefined();
    expect(
      resolveFeishuMessageAnchor({
        target: bareGroup,
        chatType: 'p2p',
        lastMessageId: 'om_latest_private_message',
      }),
    ).toBe('om_latest_private_message');
    expect(
      resolveFeishuMessageAnchor({
        target: parseFeishuRouteTarget('oc_group#root:om_explicit_root'),
        chatType: 'group',
        lastMessageId: 'om_wrong_topic',
      }),
    ).toBe('om_explicit_root');
  });

  test.each([230071, 230072])(
    'falls back one threaded physical send for Feishu error %s without re-uploading',
    async (code) => {
      const { feishu } = await connectedTransports();
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'thread-fallback-'),
      );
      const filePath = path.join(tempDir, 'payload.pdf');
      await fs.writeFile(filePath, 'payload');
      cleanup.push(() => fs.rm(tempDir, { recursive: true, force: true }));

      controls.feishuMessageReply
        .mockRejectedValueOnce({ code, message: 'reply_in_thread unsupported' })
        .mockResolvedValueOnce({ code: 0, data: { message_id: 'om_image' } });
      await expect(
        feishu.sendImage(
          'oc_group#thread:omt_1#root:om_root',
          Buffer.from('image'),
          'image/png',
        ),
      ).resolves.toBeUndefined();
      expect(controls.feishuImageCreate).toHaveBeenCalledTimes(1);
      expect(controls.feishuMessageReply).toHaveBeenCalledTimes(2);
      expect(controls.feishuMessageReply.mock.calls[0][0].data).toMatchObject({
        msg_type: 'image',
        reply_in_thread: true,
      });
      expect(
        controls.feishuMessageReply.mock.calls[1][0].data,
      ).not.toHaveProperty('reply_in_thread');

      controls.feishuMessageReply.mockReset();
      controls.feishuMessageReply
        .mockResolvedValueOnce({ code, msg: 'reply_in_thread unsupported' })
        .mockResolvedValueOnce({ code: 0, data: { message_id: 'om_file' } });
      await expect(
        feishu.sendFile(
          'oc_group#thread:omt_1#root:om_root',
          filePath,
          'payload.pdf',
        ),
      ).resolves.toBeUndefined();
      expect(controls.feishuFileCreate).toHaveBeenCalledTimes(1);
      expect(controls.feishuMessageReply).toHaveBeenCalledTimes(2);
      expect(controls.feishuMessageReply.mock.calls[0][0].data).toMatchObject({
        msg_type: 'file',
        reply_in_thread: true,
      });
      expect(
        controls.feishuMessageReply.mock.calls[1][0].data,
      ).not.toHaveProperty('reply_in_thread');
    },
  );

  test('final provider API failures reject text, image, and file sends', async () => {
    const { feishu } = await connectedTransports();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'strict-im-ack-'));
    const filePath = path.join(tempDir, 'payload.txt');
    await fs.writeFile(filePath, 'payload');
    cleanup.push(() => fs.rm(tempDir, { recursive: true, force: true }));

    controls.feishuMessageCreate.mockResolvedValue({
      code: 230001,
      msg: 'permission denied',
    });
    await expect(feishu.sendMessage('oc_1', 'hello')).rejects.toThrow(
      'code=230001',
    );
    await expect(
      feishu.sendImage('oc_1', Buffer.from('image'), 'image/png'),
    ).rejects.toThrow('code=230001');
    await expect(
      feishu.sendFile('oc_1', filePath, 'payload.txt'),
    ).rejects.toThrow('code=230001');
  });

  test('accepts SDK-unwrapped upload acknowledgements without code=0', async () => {
    const { feishu } = await connectedTransports();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'strict-im-ack-'));
    const filePath = path.join(tempDir, 'payload.pdf');
    await fs.writeFile(filePath, 'payload');
    cleanup.push(() => fs.rm(tempDir, { recursive: true, force: true }));

    await expect(
      feishu.sendImage('oc_1', Buffer.from('image'), 'image/png'),
    ).resolves.toBeUndefined();
    await expect(
      feishu.sendFile('oc_1', filePath, 'payload.pdf'),
    ).resolves.toBeUndefined();

    expect(controls.feishuImageCreate).toHaveBeenCalledOnce();
    expect(controls.feishuFileCreate).toHaveBeenCalledOnce();
  });

  test('sendMessage rejects when a requested image attachment fails', async () => {
    const { feishu } = await connectedTransports();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'strict-im-ack-'));
    const imagePath = path.join(tempDir, 'image.png');
    await fs.writeFile(imagePath, 'image');
    cleanup.push(() => fs.rm(tempDir, { recursive: true, force: true }));

    controls.feishuImageCreate.mockRejectedValue(new Error('upload denied'));
    await expect(
      feishu.sendMessage('oc_1', 'hello', [imagePath]),
    ).rejects.toThrow('upload denied');
  });
});
