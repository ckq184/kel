/**
 * ISSUE-23：iLink 返回 -14（机器人会话超时）时服务端明确拒绝了这次调用，
 * 消息不可能投递。只要本次发送还没有任何可见内容发出，就抛
 * ChannelProviderRejection，让 outbox 行落 failed 而不是 uncertain；
 * 前面已有分段或标题发出时降级为普通错误，避免重投造成重复。
 * 其他非零错误码（包括仅有第三方笔记的 -2）维持普通错误。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/im-utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/im-utils.js')>()),
  // 每个字符一段，便于构造“第二段才失败”。
  splitTextChunks: (text: string) => text.split(''),
}));
vi.mock('../src/wechat-crypto.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/wechat-crypto.js')>()),
  uploadMediaBuffer: vi.fn(async () => ({
    downloadEncryptedQueryParam: 'q',
    aeskey: 'k',
    fileSizeCiphertext: 16,
    fileSize: 1,
  })),
}));

const { assertWeChatApiSuccess } = await import('../src/wechat.js');
const { createWeChatSender } = await import('../src/wechat-outbound.js');
const { ChannelProviderRejection } = await import('../src/channel-errors.js');

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('assertWeChatApiSuccess classifies -14 as a provider rejection', () => {
  test.each([
    [{ ret: -14, errmsg: 'session timeout' }, 'ret=-14'],
    [{ errcode: -14 }, 'errcode=-14'],
    [{ ret: '-14' }, 'ret=-14'],
    [{ base_resp: { ret: -14 } }, 'base_resp.ret=-14'],
    [{ ret: -14, errcode: -14 }, 'ret=-14'],
  ])('%j → ChannelProviderRejection', (response, fragment) => {
    const error = captureError(() =>
      assertWeChatApiSuccess(response, 'sendMessage'),
    );
    expect(error).toBeInstanceOf(ChannelProviderRejection);
    expect((error as Error).message).toContain(
      `sendMessage failed: ${fragment}`,
    );
  });

  test.each([
    { ret: -2, errmsg: 'invalid context token' },
    { errcode: 40013 },
    { ret: -1 },
    { ret: -14, errcode: 5 },
  ])('%j stays an ordinary error', (response) => {
    const error = captureError(() =>
      assertWeChatApiSuccess(response, 'sendMessage'),
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ChannelProviderRejection);
  });
});

function makeSender(responses: Array<Record<string, unknown>>) {
  const apiPost = vi.fn(async () => responses.shift() ?? { ret: 0 });
  const sender = createWeChatSender(
    {
      apiPost,
      baseInfo: () => ({}),
      ensureDispatcher: () => ({}) as never,
    },
    new Map([['user-1', 'ctx']]),
    { botToken: 'bot-token' },
    assertWeChatApiSuccess,
  );
  return { sender, apiPost };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (err: unknown) => err,
  );
}

describe('WeChat outbound keeps -14 definitive only before visible output', () => {
  test('first text chunk rejected → ChannelProviderRejection', async () => {
    const { sender, apiPost } = makeSender([{ ret: -14 }]);
    const error = await rejection(sender.sendMessage('user-1', 'ab'));
    expect(error).toBeInstanceOf(ChannelProviderRejection);
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  test('later text chunk rejected → ordinary error (earlier chunk visible)', async () => {
    const { sender } = makeSender([{ ret: 0 }, { ret: -14 }]);
    const error = await rejection(sender.sendMessage('user-1', 'ab'));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ChannelProviderRejection);
    expect((error as Error).message).toBe('sendMessage failed: ret=-14');
    expect((error as Error).cause).toBeInstanceOf(ChannelProviderRejection);
  });

  test('image rejected with no caption → ChannelProviderRejection', async () => {
    const { sender } = makeSender([{ ret: -14 }]);
    const error = await rejection(
      sender.sendImage('user-1', Buffer.from('x'), 'image/png'),
    );
    expect(error).toBeInstanceOf(ChannelProviderRejection);
  });

  test('caption rejected before the image → ChannelProviderRejection', async () => {
    const { sender } = makeSender([{ ret: -14 }]);
    const error = await rejection(
      sender.sendImage('user-1', Buffer.from('x'), 'image/png', 'c'),
    );
    expect(error).toBeInstanceOf(ChannelProviderRejection);
  });

  test('image rejected after its caption was sent → ordinary error', async () => {
    const { sender } = makeSender([{ ret: 0 }, { ret: -14 }]);
    const error = await rejection(
      sender.sendImage('user-1', Buffer.from('x'), 'image/png', 'c'),
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ChannelProviderRejection);
  });

  test('file rejected → ChannelProviderRejection', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-ilink-'));
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'x');
    try {
      const { sender } = makeSender([{ ret: -14 }]);
      const error = await rejection(sender.sendFile('user-1', file, 'a.txt'));
      expect(error).toBeInstanceOf(ChannelProviderRejection);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('other codes stay ordinary even on the first call', async () => {
    const { sender } = makeSender([{ ret: -2 }]);
    const error = await rejection(sender.sendMessage('user-1', 'a'));
    expect(error).not.toBeInstanceOf(ChannelProviderRejection);
  });
});
