import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { Message } from '../web/src/stores/chat';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

/** 提取 source 中每个 `broadcastToWebClients(...)` 调用的实参文本（括号配平）。 */
function extractCallArgs(source: string, callee: string): string[] {
  const calls: string[] = [];
  let cursor = 0;
  while (true) {
    const start = source.indexOf(`${callee}(`, cursor);
    if (start < 0) break;
    let depth = 0;
    let i = start + callee.length;
    for (; i < source.length; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    calls.push(source.slice(start + callee.length + 1, i));
    cursor = i + 1;
  }
  return calls;
}

describe('agent_reply notice broadcast contract', () => {
  test('the agent_reply payload declares the notice discriminator', () => {
    const types = read('src/types.ts');
    const block = types.slice(
      types.indexOf("type: 'agent_reply';"),
      types.indexOf("type: 'typing';"),
    );
    expect(block).toContain('notice?: boolean');
  });

  test('broadcastToWebClients forwards the notice option into the payload', () => {
    const web = read('src/web.ts');
    const fn = web.slice(
      web.indexOf('export function broadcastToWebClients'),
      web.indexOf('export function broadcastNewMessage'),
    );
    expect(fn).toContain('notice');
  });

  test('every warning broadcast carries notice:true; only full-output broadcasts stay unmarked', () => {
    // ISSUE-12 波 4 单元 4.4/4.7：send_image 与 send_file 分支的
    // broadcastToWebClients 调用随段迁入 src/ipc/image-delivery.ts 与
    // src/ipc/file-delivery.ts（原文搬运），扫描面扩至三文件合计，
    // 计数与断言语义不变。
    const index = read('src/index.ts');
    const imageBranch = read('src/ipc/image-delivery.ts');
    const fileBranch = read('src/ipc/file-delivery.ts');
    const calls = [
      ...extractCallArgs(index, 'broadcastToWebClients'),
      ...extractCallArgs(imageBranch, 'broadcastToWebClients'),
      ...extractCallArgs(fileBranch, 'broadcastToWebClients'),
    ];
    // 6 处 ⚠️ 警告 + 2 处完整输出冗余广播（文本回复 jid,text 与图片
    // displayText，均同步经 new_message 承载，前端无需消费 agent_reply）
    expect(calls.length).toBe(8);

    const fullOutputs = calls.filter(
      (args) =>
        args.trim() === 'jid, text' ||
        args.trim() === 'imgChatJid, displayText',
    );
    expect(fullOutputs.length).toBe(2);

    for (const args of calls) {
      if (fullOutputs.includes(args)) continue;
      expect(args).toContain('notice: true');
    }
  });

  test('frontend subscribes to agent_reply and routes notices into the chat store', () => {
    const layout = read('web/src/components/layout/AppLayout.tsx');
    const chat = read('web/src/stores/chat.ts');

    expect(layout).toContain("wsManager.on('agent_reply'");
    expect(layout).toContain('handleAgentNotice');
    expect(chat).toContain('handleAgentNotice:');
    expect(chat).toContain("'__system__'");
  });
});

const { apiGetMock, showToastMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  showToastMock: vi.fn(),
}));

vi.mock('../web/src/api/client', () => ({
  api: {
    get: apiGetMock,
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../web/src/api/ws', () => ({
  wsManager: {
    send: vi.fn(() => true),
    on: vi.fn(() => vi.fn()),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
  },
}));

vi.mock('../web/src/stores/files', () => ({
  useFileStore: {
    getState: () => ({ loadFiles: vi.fn() }),
  },
}));

vi.mock('../web/src/stores/auth', () => ({
  useAuthStore: {
    getState: () => ({ user: null }),
  },
}));

vi.mock('../web/src/utils/toast', () => ({
  showToast: showToastMock,
  notifyIfHidden: vi.fn(),
  showNotificationPromptToast: vi.fn(),
}));

vi.mock('../web/src/utils/messageSnapshotCache', () => ({
  deleteAgentMessageSnapshot: vi.fn(),
  deleteGroupMessageSnapshots: vi.fn(),
  loadAgentMessageSnapshot: vi.fn(),
  saveAgentMessageSnapshot: vi.fn(),
}));

const { useChatStore } = await import('../web/src/stores/chat');

function currentNoticeMessages(jid: string): Message[] {
  const state = useChatStore.getState();
  return (state.messages[jid] || []).filter((m) => m.sender === '__system__');
}

describe('handleAgentNotice (chat store)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState(
      {
        messages: {},
        currentGroup: null,
        unreadReplies: {},
      },
      false,
    );
  });

  test('appends an ephemeral system message for the target chat without touching waiting/streaming', () => {
    useChatStore
      .getState()
      .handleAgentNotice('web:main', '⚠️ 文件 "a.txt" 发送失败，请稍后重试。');

    const notices = currentNoticeMessages('web:main');
    expect(notices).toHaveLength(1);
    expect(notices[0].content).toBe('⚠️ 文件 "a.txt" 发送失败，请稍后重试。');
    expect(notices[0].is_from_me).toBe(false);
    expect(notices[0].id).toMatch(/^local-notice-/);

    const state = useChatStore.getState();
    expect(state.waiting['web:main']).toBeUndefined();
    expect(state.streaming['web:main']).toBeUndefined();
  });

  test('toasts when the notice targets a chat that is not currently open', () => {
    useChatStore.setState({ currentGroup: 'web:other' });
    useChatStore
      .getState()
      .handleAgentNotice('web:main', '⚠️ 图片 "x.png" 发送失败。');

    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(String(showToastMock.mock.calls[0][1])).toContain('x.png');
  });

  test('does not toast when the notice belongs to the open chat (rendered in-flow)', () => {
    useChatStore.setState({ currentGroup: 'web:main' });
    useChatStore
      .getState()
      .handleAgentNotice('web:main', '⚠️ 图片 "x.png" 发送失败。');

    expect(showToastMock).not.toHaveBeenCalled();
    expect(currentNoticeMessages('web:main')).toHaveLength(1);
  });
});
