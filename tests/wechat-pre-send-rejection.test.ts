/**
 * ISSUE-19 T1：微信出站在调用 iLink 之前就能确定的拒绝（缺 context_token、
 * 图片或文件超过大小上限）必须抛 ChannelPreSendRejection，让 outbox 状态机
 * 把行落 failed，而不是当作结果不确定的 uncertain 封住整个 turn。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/im-downloader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/im-downloader.js')>()),
  MAX_FILE_SIZE: 16,
}));

const { createWeChatSender } = await import('../src/wechat-outbound.js');
const { ChannelPreSendRejection } = await import('../src/channel-errors.js');

function makeSender(tokens: Record<string, string> = {}) {
  const apiPost = vi.fn(async () => ({ ret: 0 }));
  const sender = createWeChatSender(
    {
      apiPost,
      baseInfo: () => ({}),
      ensureDispatcher: () => ({}) as never,
    },
    new Map(Object.entries(tokens)),
    { botToken: 'bot-token' },
    () => {},
  );
  return { sender, apiPost };
}

describe('WeChat pre-send rejections', () => {
  test.each(['sendMessage', 'sendImage', 'sendFile'] as const)(
    '%s without a context_token rejects before calling iLink',
    async (method) => {
      const { sender, apiPost } = makeSender();
      const call =
        method === 'sendMessage'
          ? sender.sendMessage('user-1', 'hi')
          : method === 'sendImage'
            ? sender.sendImage('user-1', Buffer.from('x'), 'image/png')
            : sender.sendFile('user-1', '/nonexistent', 'a.txt');
      const error = await call.then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(ChannelPreSendRejection);
      expect((error as Error).message).toBe(
        'No context_token available for WeChat chat user-1',
      );
      expect(apiPost).not.toHaveBeenCalled();
    },
  );

  test('an oversized image rejects before calling iLink', async () => {
    const { sender, apiPost } = makeSender({ 'user-1': 'ctx' });
    await expect(
      sender.sendImage('user-1', Buffer.alloc(17), 'image/png', 'caption'),
    ).rejects.toBeInstanceOf(ChannelPreSendRejection);
    expect(apiPost).not.toHaveBeenCalled();
  });

  test('an oversized file rejects before calling iLink', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-presend-'));
    const file = path.join(dir, 'big.bin');
    fs.writeFileSync(file, Buffer.alloc(17));
    try {
      const { sender, apiPost } = makeSender({ 'user-1': 'ctx' });
      await expect(
        sender.sendFile('user-1', file, 'big.bin'),
      ).rejects.toBeInstanceOf(ChannelPreSendRejection);
      expect(apiPost).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a provider error after the call is still an ordinary error', async () => {
    const { sender, apiPost } = makeSender({ 'user-1': 'ctx' });
    apiPost.mockRejectedValueOnce(new Error('socket hang up'));
    const error = await sender.sendMessage('user-1', 'hi').then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ChannelPreSendRejection);
  });
});
