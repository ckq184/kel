// @vitest-environment happy-dom

import fs from 'node:fs';
import path from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Admin flag toggled per test group; the mocked auth store resolves it.
const state = vi.hoisted(() => ({ isAdmin: false }));
const apiGet = vi.hoisted(() => vi.fn());
const apiPost = vi.hoisted(() => vi.fn());

vi.mock('../web/src/api/client', () => ({
  api: { get: apiGet, post: apiPost },
}));

vi.mock('../web/src/api/ws', () => ({
  wsManager: { on: vi.fn(() => () => {}) },
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

const IDLE_TRIGGER = {
  running: false,
  startedAt: null,
  startedBy: null,
  lines: [] as string[],
  result: null,
};

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiGet.mockImplementation(async (url: string) => {
    if (url.includes('trigger/status')) return IDLE_TRIGGER;
    if (url.startsWith('/api/eval/datasets')) return { datasets: [] };
    return { runs: [], total: 0, items: [] };
  });
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
  configJson: {
    dataset: 'auto-recall',
    datasetOrigin: 'db',
    llmModel: 'glm-4-flash',
    embedderModel: 'Embedding-3',
    source: 'file',
  },
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
      if (url.includes('trigger/status')) return IDLE_TRIGGER;
      if (url.startsWith('/api/eval/datasets')) return { datasets: [] };
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

describe('EvalPage web trigger (task AC)', () => {
  test('members never see the run-trigger button', async () => {
    state.isAdmin = false;
    await renderPage();
    expect(container?.textContent).not.toContain('运行评测');
  });

  test('admins see the trigger button and a cost-warning dialog with fields', async () => {
    state.isAdmin = true;
    await renderPage();

    const trigger = [...container!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('运行评测'),
    );
    expect(trigger).toBeTruthy();
    await act(async () => {
      trigger?.click();
    });
    await act(async () => {});

    const dialog = container?.querySelector(
      '[role="dialog"], [data-eval-run-dialog]',
    );
    expect(dialog).toBeTruthy();
    expect(dialog?.textContent).toContain('费用');
    expect(dialog?.querySelector('[data-eval-run-k]')).toBeTruthy();
    expect(dialog?.querySelector('[data-eval-run-name]')).toBeTruthy();
    expect(dialog?.querySelector('[data-eval-run-reset]')).toBeTruthy();
  });

  test('while a run is active the trigger button is disabled and progress shows', async () => {
    state.isAdmin = true;
    apiGet.mockImplementation(async (url: string) => {
      if (url.includes('/runs/trigger/status')) {
        return {
          running: true,
          startedAt: 1,
          startedBy: 'user-admin',
          lines: ['golden set: 20 memories / 17 queries (k=5)'],
          result: null,
        };
      }
      return { runs: [] };
    });
    await renderPage();

    const trigger = [...container!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('运行评测'),
    );
    expect(trigger).toBeTruthy();
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    expect(container?.textContent).toContain('golden set: 20 memories');
  });
});

const datasetFixture = {
  name: 'auto-recall',
  description: '内置召回评测集',
  data: {
    seed: [
      { marker: 'M01', content: '用户是 Java 后端开发者。', keys: ['Java'] },
    ],
    queries: [
      { id: 'q1', category: 'verbatim', text: 'Java?', expected: ['M01'] },
    ],
  },
  source: 'builtin',
  createdAt: '2026-11-11T08:00:00.000Z',
  updatedAt: '2026-11-11T08:00:00.000Z',
};

function stubDatasets(apiGetMock: ReturnType<typeof vi.fn>, withDetail = true) {
  apiGetMock.mockImplementation(async (url: string) => {
    if (url.includes('trigger/status')) return IDLE_TRIGGER;
    if (url.startsWith('/api/eval/datasets/')) {
      return withDetail ? datasetFixture : null;
    }
    if (url.startsWith('/api/eval/datasets')) {
      return {
        datasets: [
          {
            name: 'auto-recall',
            description: '内置召回评测集',
            source: 'builtin',
            seedCount: 20,
            queryCount: 17,
            createdAt: datasetFixture.createdAt,
            updatedAt: datasetFixture.updatedAt,
          },
        ],
      };
    }
    return { runs: [], total: 0, items: [] };
  });
}

describe('EvalPage datasets tab (task AD)', () => {
  test('admins see the datasets tab; members do not', async () => {
    state.isAdmin = true;
    stubDatasets(apiGet);
    await renderPage();
    const tabButtons = [
      ...container!.querySelectorAll('button[role="tab"]'),
    ].map((button) => button.textContent);
    expect(tabButtons).toEqual(['离线评测', '真实对话', '评测集']);

    state.isAdmin = false;
    await renderPage();
    const memberTabs = [
      ...container!.querySelectorAll('button[role="tab"]'),
    ].map((button) => button.textContent);
    expect(memberTabs).toEqual(['离线评测']);
  });

  test('dataset list renders builtin set; editor opens with visual rows', async () => {
    state.isAdmin = true;
    stubDatasets(apiGet);
    await renderPage();
    const tab = [...container!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('评测集'),
    );
    await act(async () => {
      tab?.click();
    });
    await act(async () => {});

    expect(container?.textContent).toContain('auto-recall');
    expect(container?.textContent).toContain('20');

    // Open the editor on the first dataset.
    const open = [...container!.querySelectorAll('button')].find((button) =>
      button.getAttribute('aria-label')?.includes('auto-recall'),
    );
    await act(async () => {
      open?.click();
    });
    await act(async () => {});

    // Visual editor: seed row fields + query row fields both rendered.
    expect(container?.querySelector('[data-ds-seed-marker]')).toBeTruthy();
    expect(container?.querySelector('[data-ds-seed-content]')).toBeTruthy();
    expect(container?.querySelector('[data-ds-seed-keys]')).toBeTruthy();
    expect(container?.querySelector('[data-ds-query-id]')).toBeTruthy();
    expect(container?.querySelector('[data-ds-query-category]')).toBeTruthy();
    expect(container?.querySelector('[data-ds-query-text]')).toBeTruthy();
    expect(container?.querySelector('[data-ds-query-expected]')).toBeTruthy();
  });

  test('import entry (JSON paste + file) and new-set button exist', async () => {
    state.isAdmin = true;
    stubDatasets(apiGet, false);
    await renderPage();
    const tab = [...container!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('评测集'),
    );
    await act(async () => {
      tab?.click();
    });
    await act(async () => {});

    expect(container?.querySelector('[data-ds-import-text]')).toBeTruthy();
    expect(container?.querySelector('[data-ds-import-file]')).toBeTruthy();
    const newButton = [...container!.querySelectorAll('button')].find(
      (button) => button.textContent?.includes('新建评测集'),
    );
    expect(newButton).toBeTruthy();
  });

  test('trigger dialog offers a dataset selector', async () => {
    state.isAdmin = true;
    stubDatasets(apiGet);
    await renderPage();
    const trigger = [...container!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('运行评测'),
    );
    await act(async () => {
      trigger?.click();
    });
    await act(async () => {});
    const select = container?.querySelector('[data-eval-run-dataset]');
    expect(select).toBeTruthy();
    expect(select?.textContent).toContain('auto-recall');
  });
});

describe('metric labels are localized (task AD follow-up)', () => {
  test('run list chips and comparison headers use Chinese labels', async () => {
    state.isAdmin = false;
    apiGet.mockImplementation(async (url: string) => {
      if (url.includes('trigger/status')) return IDLE_TRIGGER;
      if (url.startsWith('/api/eval/datasets')) return { datasets: [] };
      return { runs: [runFixture] };
    });
    await renderPage();
    expect(container?.textContent).toContain('召回率');
    expect(container?.textContent).toContain('命中率');
    const source = fs.readFileSync(
      path.join(path.resolve(__dirname, '..'), 'web/src/pages/EvalPage.tsx'),
      'utf8',
    );
    expect(source).toContain('排序 MRR');
    expect(source).toContain('精确率');
    expect(source).not.toMatch(/<th className="py-2 pr-4">recall</);
  });
});

describe('run detail shows dataset provenance (task AD follow-up)', () => {
  test('clicking a run surfaces the dataset name and origin', async () => {
    state.isAdmin = false;
    apiGet.mockImplementation(async (url: string) => {
      if (url.includes('trigger/status')) return IDLE_TRIGGER;
      if (url.startsWith('/api/eval/datasets')) return { datasets: [] };
      if (url.startsWith('/api/eval/runs/')) {
        return {
          run: runFixture,
          items: [
            {
              id: 1,
              queryId: 'q1',
              category: 'verbatim',
              expected: ['M1'],
              retrieved: ['M1'],
              recall: 1,
              hit: 1,
              mrr: 1,
              precision: 1,
              latencyMs: 90,
              note: null,
            },
          ],
        };
      }
      return { runs: [runFixture] };
    });
    await renderPage();

    const row = [...container!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('run-20261111'),
    );
    await act(async () => {
      row?.click();
    });
    await act(async () => {});

    expect(container?.textContent).toContain('Run 详情 · run-20261111');
    expect(container?.textContent).toContain('评测集 auto-recall');
    expect(container?.textContent).toContain('eval.db');
  });
});
