// @vitest-environment happy-dom

/**
 * THESIS-09：聊天气泡只显示耗时。
 *
 * 组件用例覆盖三条验收：
 * - 新格式（durationMs + numTurns）只渲染耗时；
 * - 旧格式的历史消息（含完整 token 明细）仍能解析，但只渲染耗时；
 * - 耗时为 0 或缺失时不渲染。
 *
 * 明细提示（Tooltip）在 happy-dom 中不会展开，由
 * tests/thesis-09-bubble-duration-only.test.ts 的源码契约兜底。
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { MessageBubble } from '../web/src/components/chat/MessageBubble';
import { useAuthStore, type UserPublic } from '../web/src/stores/auth';
import type { Message } from '../web/src/stores/chat';

vi.mock('../web/src/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const user: UserPublic = {
  id: 'user-thesis-09',
  username: 'tester',
  display_name: '测试者',
  role: 'admin',
  status: 'active',
  permissions: [],
  must_change_password: false,
  disable_reason: null,
  notes: null,
  created_at: '2026-11-25T00:00:00.000Z',
  last_login_at: null,
  last_active_at: null,
  deleted_at: null,
  avatar_emoji: null,
  avatar_color: null,
  avatar_url: null,
  default_require_mention: false,
};

useAuthStore.setState({ authenticated: true, user, appearance: null });

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderBubble(tokenUsage: string): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const message: Message = {
    id: 'message-thesis-09',
    chat_jid: 'web:thesis-09',
    sender: 'agent',
    sender_name: 'Agent',
    content: 'reply',
    timestamp: '2026-11-25T00:00:00.000Z',
    is_from_me: true,
    token_usage: tokenUsage,
  };
  await act(async () => {
    root?.render(<MessageBubble message={message} showTime={false} />);
  });
  return container;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('聊天气泡只渲染耗时', () => {
  test('新格式只出现耗时，不出现 token 数', async () => {
    const rendered = await renderBubble(
      JSON.stringify({ durationMs: 2_500, numTurns: 2 }),
    );

    expect(rendered.textContent).toContain('2.5s');
    expect(rendered.textContent).not.toMatch(/tokens/i);
    expect(rendered.textContent).not.toMatch(/\d+(\.\d+)?K/);
  });

  test('旧格式的历史消息仍能解析，但只显示耗时', async () => {
    const rendered = await renderBubble(
      JSON.stringify({
        inputTokens: 1_000,
        outputTokens: 500,
        cacheReadInputTokens: 100_000,
        cacheCreationInputTokens: 25_000,
        reasoningTokens: 750,
        costUSD: 1.2345,
        durationMs: 2_500,
        numTurns: 3,
        modelUsage: {
          'claude-opus': {
            inputTokens: 900,
            outputTokens: 450,
            costUSD: 2,
          },
        },
      }),
    );

    expect(rendered.textContent).toContain('2.5s');
    expect(rendered.textContent).not.toMatch(/tokens/i);
    expect(rendered.textContent).not.toMatch(/\d+(\.\d+)?K/);
    expect(rendered.textContent).not.toContain('claude-opus');
  });

  test('耗时为 0 时不渲染', async () => {
    const rendered = await renderBubble(
      JSON.stringify({ durationMs: 0, numTurns: 3 }),
    );

    expect(rendered.textContent).not.toMatch(/\d+(\.\d+)?s\b/);
    expect(rendered.textContent).not.toMatch(/tokens/i);
  });

  test('耗时缺失时不渲染', async () => {
    const rendered = await renderBubble(JSON.stringify({ numTurns: 3 }));

    expect(rendered.textContent).not.toMatch(/\d+(\.\d+)?s\b/);
    expect(rendered.textContent).not.toMatch(/tokens/i);
  });

  test('负耗时不渲染', async () => {
    const rendered = await renderBubble(
      JSON.stringify({ durationMs: -1_000, numTurns: 3 }),
    );

    expect(rendered.textContent).not.toMatch(/\d+(\.\d+)?s\b/);
    expect(rendered.textContent).not.toMatch(/tokens/i);
  });

  test('非数字耗时不渲染', async () => {
    const rendered = await renderBubble(
      JSON.stringify({ durationMs: '2500', numTurns: 3 }),
    );

    expect(rendered.textContent).not.toMatch(/\d+(\.\d+)?s\b/);
    expect(rendered.textContent).not.toMatch(/tokens/i);
  });

  test('无法解析的 token_usage 不影响消息渲染', async () => {
    const rendered = await renderBubble('not-json');

    expect(rendered.textContent).toContain('reply');
    expect(rendered.textContent).not.toMatch(/tokens/i);
  });
});
