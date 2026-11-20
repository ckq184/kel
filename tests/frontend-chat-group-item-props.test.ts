import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('ChatGroupItem lastMessage prop removal', () => {
  test('ChatGroupItem no longer accepts a lastMessage prop it never renders', () => {
    const item = read('web/src/components/chat/ChatGroupItem.tsx');
    expect(item).not.toContain('lastMessage');
  });

  test('all four pass sites stop threading lastMessage into ChatGroupItem', () => {
    const sidebar = read('web/src/components/layout/UnifiedSidebar.tsx');
    const chatPage = read('web/src/pages/ChatPage.tsx');

    expect(sidebar).not.toContain('lastMessage=');
    expect(chatPage).not.toContain('lastMessage=');
  });

  test('the backend lastMessage field keeps its live consumer in ChatView session sidebar', () => {
    // 交叉核实结论：后端 groups.ts:380 的 lastMessage 并非死字段——
    // ChatView 把它作为主对话行的 meta 渲染（契约见
    // tests/frontend-session-sidebar-copy.test.ts），删后端字段会伤及该展示。
    const chatView = read('web/src/components/chat/ChatView.tsx');
    expect(chatView).toContain('mainMeta={group.lastMessage');
  });
});
