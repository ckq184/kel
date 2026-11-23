/**
 * ISSUE-19 T2：context_token 回调在适配器与启动接线中的透传。
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';
import type {
  WeChatConnectOpts,
  WeChatConnectionConfig,
} from '../src/wechat.js';

const capture = vi.hoisted(() => ({
  configs: [] as WeChatConnectionConfig[],
  opts: null as WeChatConnectOpts | null,
}));

vi.mock('../src/wechat.js', () => ({
  createWeChatConnection: (config: WeChatConnectionConfig) => {
    capture.configs.push({
      ...config,
      contextTokens: { ...config.contextTokens },
    });
    return {
      async connect(opts: WeChatConnectOpts) {
        capture.opts = opts;
      },
      async disconnect() {},
      async sendMessage() {},
      async sendImage() {},
      async sendFile() {},
      async sendTyping() {},
      isRunning: () => true,
      isConnected: () => true,
      getUpdatesBuf: () => '',
    };
  },
}));

const { createWeChatChannel } = await import('../src/im-channel.js');

describe('WeChat context token wiring', () => {
  test('adapter forwards new tokens and reconnects with the latest set', async () => {
    const onContextToken = vi.fn();
    const channel = createWeChatChannel(
      { botToken: 't', ilinkBotId: 'bot', contextTokens: { a: 'ctx-a' } },
      undefined,
      onContextToken,
    );
    await channel.connect({ onNewChat: vi.fn() });
    capture.opts?.onContextToken?.('b', 'ctx-b');
    expect(onContextToken).toHaveBeenCalledWith('b', 'ctx-b');

    await channel.disconnect();
    await channel.connect({ onNewChat: vi.fn() });
    expect(capture.configs.at(-1)?.contextTokens).toEqual({
      a: 'ctx-a',
      b: 'ctx-b',
    });
  });

  test('index.ts restores and persists tokens through the account secret', () => {
    const source = fs
      .readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8')
      .replace(/\r\n/g, '\n');
    const start = source.indexOf("account.provider === 'wechat'");
    const branch = source.slice(
      start,
      source.indexOf('onUpdatesBuf: (cursor', start),
    );
    expect(branch).toMatch(
      /contextTokens: parseWeChatContextTokens\(\s*secret\.contextTokens,\s*secret\.ilinkBotId,?\s*\)/,
    );
    expect(branch).toMatch(/onContextToken: \(userId, token\) =>/);
    const handler = branch.slice(branch.indexOf('onContextToken:'));
    expect(handler).toMatch(/loadChannelAccountSecret\(account\.secret_ref\)/);
    expect(handler).toMatch(/serializeWeChatContextTokens\(/);
    expect(handler).toMatch(/saveChannelAccountSecret\(account\.secret_ref,/);
    expect(handler).not.toMatch(/logger\.\w+\([^)]*token/);
  });
});
