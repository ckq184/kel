// @vitest-environment happy-dom

import fs from 'node:fs';
import path from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Admin flag toggled per test group; the mocked auth store resolves it.
const state = vi.hoisted(() => ({ isAdmin: false }));
const apiGet = vi.hoisted(() => vi.fn());

vi.mock('../web/src/api/client', () => ({
  api: { get: apiGet },
}));

vi.mock('../web/src/stores/auth', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({
      hasPermission: (permission: string) =>
        state.isAdmin && permission === 'manage_system_config',
    }),
}));

const { EvalPage } = await import('../web/src/pages/EvalPage');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderPage(): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<EvalPage />);
  });
  // Let the initial data loads flush.
  await act(async () => {});
}

beforeEach(() => {
  apiGet.mockReset();
  apiGet.mockResolvedValue({ runs: [], total: 0, items: [] });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const runFixture = {
  id: 'run-20261111',
  name: 'run-20261111',
  kind: 'recall',
  k: 5,
  configJson: null,
  summary: {
    overall: { n: 17, recall: 0.82, hitRate: 0.94, mrr: 0.71, precision: 0.55 },
    perCategory: {},
  },
  judgePromptHash: null,
  judgeModel: null,
  createdAt: '2026-11-11T08:00:00.000Z',
};

const turnFixture = {
  turnId: 'turn-1',
  sessionId: 'sess-1',
  workspaceJid: 'web:ws-a',
  folder: 'ws-a',
  channel: 'web',
  interactionMode: 'assistant',
  autoRecallEnabled: 1,
  recallInjected: 1,
  recallHitCount: 3,
  recallLatencyMs: 412,
  inputText: '帮我回忆上次的项目决定',
  outputText: '根据记录，上次决定……',
  inputTokens: 1200,
  outputTokens: 340,
  costUsd: 0.012,
  durationMs: 5600,
  judgeUsed: 1,
  judgeReasoning: '回答引用了召回内容',
  judgeError: null,
  judgePromptHash: 'abc123',
  judgeModel: 'glm-4-flash',
  createdAt: '2026-11-11T09:00:00.000Z',
};

describe('EvalPage wiring (files + routes)', () => {
  const webRoot = path.resolve(__dirname, '../web/src');

  test('EvalPage exists and declares both tabs with the admin-only gate', () => {
    const source = fs.readFileSync(
      path.join(webRoot, 'pages', 'EvalPage.tsx'),
      'utf8',
    );
    expect(source).toContain('离线评测');
    expect(source).toContain('真实对话');
    expect(source).toContain('manage_system_config');
    // Tab2 ACL is enforced inside the page too (not only at the route).
    expect(source).toContain('hasPermission');
  });

  test('App.tsx routes /eval with the admin gate only where required', () => {
    const source = fs.readFileSync(path.join(webRoot, 'App.tsx'), 'utf8');
    expect(source).toMatch(
      /lazy\(\s*\(\)\s*=>\s*import\('\.\/pages\/EvalPage'\)/,
    );
    expect(source).toContain('path="/eval"');
  });

  test('nav-items carries the eval entry', () => {
    const source = fs.readFileSync(
      path.join(webRoot, 'components', 'layout', 'nav-items.ts'),
      'utf8',
    );
    expect(source).toContain("path: '/eval'");
    expect(source).toContain('评测');
  });
});

describe('EvalPage tabs (DOM)', () => {
  test('Tab1 lists offline runs with k and overall metrics', async () => {
    state.isAdmin = false;
    apiGet.mockResolvedValue({ runs: [runFixture] });
    await renderPage();

    expect(container?.textContent).toContain('离线评测');
    expect(container?.textContent).toContain('run-20261111');
    expect(container?.textContent).toContain('k=5');
    // Overall recall surfaced on the list row.
    expect(container?.textContent).toMatch(/82/);
  });

  test('members never see the observed-turns tab', async () => {
    state.isAdmin = false;
    await renderPage();
    const tabButtons = [...container!.querySelectorAll('button[role="tab"]')];
    expect(tabButtons.map((button) => button.textContent)).toEqual([
      '离线评测',
    ]);
  });

  test('admins see observed turns with metadata filters', async () => {
    state.isAdmin = true;
    apiGet.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/eval/turns')) {
        return { items: [turnFixture], total: 1 };
      }
      if (url.startsWith('/api/eval/runs')) return { runs: [] };
      return { runs: [] };
    });
    await renderPage();

    // Switch to the turns tab.
    const tabButton = [...container!.querySelectorAll('button')].find(
      (button) => button.textContent?.includes('真实对话'),
    );
    expect(tabButton).toBeTruthy();
    await act(async () => {
      tabButton?.click();
    });
    await act(async () => {});

    expect(container?.textContent).toContain('turn-1');
    expect(container?.textContent).toContain('web:ws-a');
    expect(container?.textContent).toContain('真实对话');
  });
});
