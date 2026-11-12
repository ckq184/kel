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
const apiPut = vi.hoisted(() => vi.fn());

vi.mock('../web/src/api/client', () => ({
  api: { get: apiGet, post: apiPost, put: apiPut },
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
  apiPut.mockReset();
  apiPut.mockResolvedValue({ ok: true });
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
    expect(tabButtons).toEqual([
      '离线评测',
      '真实对话',
      '评测集',
      'Harness 演化',
    ]);

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

// ── Harness evolution tab (task AE, RSI Phase 1) ────────────────────────────

const PROPOSAL_FIXTURE = {
  id: 'hp_web1',
  workspaceJid: 'feishu:ws-ae@g.us',
  status: 'pending',
  keepBase: false,
  rationale: '三个财务 turn 一致漏币种确认。',
  evidenceCount: 2,
  baselineVersion: 0,
  model: 'glm-flash',
  promptHash: 'hash',
  createdAt: '2026-11-11T00:00:00Z',
  decidedAt: null,
  decidedBy: null,
};

const PROPOSAL_DETAIL_FIXTURE = {
  ...PROPOSAL_FIXTURE,
  adapterMd: '# Adapter\n\n先确认币种再算金额。',
  diff: '+ 先确认币种',
  evidence: [
    {
      turnId: 't1',
      inputExcerpt: '算报销',
      outputExcerpt: '1200 元',
      why: '未确认币种',
    },
  ],
};

const VERSIONS_FIXTURE = {
  versions: [
    {
      id: 'hv_2',
      version: 2,
      active: true,
      proposalId: 'hp_web1',
      adapterMd: '# v2',
      adoptedBy: 'user-admin',
      createdAt: '2026-11-11T01:00:00Z',
    },
    {
      id: 'hv_1',
      version: 1,
      active: false,
      proposalId: null,
      adapterMd: '# v1',
      adoptedBy: 'user-admin',
      createdAt: '2026-11-11T00:00:00Z',
    },
  ],
};

// Task AH: idle evolve-trigger snapshot (the shared fallback for every
// harness-tab mock so the new endpoints never fall through to run shapes).
const EVOLVE_IDLE = {
  running: false,
  workspace: null,
  startedAt: null,
  startedBy: null,
  lines: [] as string[],
  result: null,
};

describe('EvalPage harness tab (task AE)', () => {
  beforeEach(() => {
    apiGet.mockImplementation(async (url: string) => {
      if (url.includes('trigger/status')) return IDLE_TRIGGER;
      if (url.startsWith('/api/eval/datasets')) return { datasets: [] };
      if (url.includes('/api/eval/harness/evidence-status'))
        return {
          turnsSinceLastProposal: 0,
          lastProposalAt: null,
          activeVersion: 0,
        };
      if (url.includes('/api/eval/harness/evolve/status')) return EVOLVE_IDLE;
      if (url.includes('/api/eval/harness/proposals/'))
        return PROPOSAL_DETAIL_FIXTURE;
      if (url.includes('/api/eval/harness/proposals'))
        return { proposals: [PROPOSAL_FIXTURE] };
      if (url.includes('/api/eval/harness/versions')) return VERSIONS_FIXTURE;
      if (url.includes('/api/eval/harness/lessons')) return { lessons: [] };
      return { runs: [], total: 0, items: [] };
    });
  });

  async function openHarnessTab(): Promise<void> {
    state.isAdmin = true;
    await renderPage();
    const tab = [...container!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Harness 演化'),
    );
    await act(async () => {
      tab?.click();
    });
    await act(async () => {});
  }

  test('member never sees the harness tab', async () => {
    state.isAdmin = false;
    await renderPage();
    const tabs = [...container!.querySelectorAll('button[role="tab"]')].map(
      (button) => button.textContent,
    );
    expect(tabs).not.toContain('Harness 演化');
  });

  async function loadWorkspaceData(): Promise<void> {
    const input = container?.querySelector('[data-harness-workspace]');
    // React-controlled input: drive the native setter so the value tracker
    // registers the change, then let the input event propagate.
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      nativeSetter?.call(input, 'feishu:ws-ae@g.us');
      (input as HTMLInputElement).dispatchEvent(
        new Event('input', { bubbles: true }),
      );
    });
    const load = [...container!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('加载'),
    );
    await act(async () => {
      load?.click();
    });
    await act(async () => {});
  }

  test('workspace input loads the pending proposal list', async () => {
    await openHarnessTab();
    const input = container?.querySelector('[data-harness-workspace]');
    expect(input).toBeTruthy();
    await loadWorkspaceData();
    expect(container?.textContent).toContain('hp_web1');
    expect(container?.textContent).toContain('待审');
    expect(container?.textContent).toContain('漏币种');
  });

  test('proposal detail renders adapter body, diff, and evidence; adopt posts', async () => {
    await openHarnessTab();
    await loadWorkspaceData();
    // Expand the first proposal.
    const row = [...container!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('hp_web1'),
    );
    await act(async () => {
      row?.click();
    });
    await act(async () => {});
    expect(container?.textContent).toContain('先确认币种再算金额');
    expect(container?.textContent).toContain('未确认币种');

    apiPost.mockResolvedValueOnce({ ok: true, version: 1 });
    const adopt = [...container!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('采纳'),
    );
    expect(adopt).toBeTruthy();
    await act(async () => {
      adopt?.click();
    });
    await act(async () => {});
    expect(apiPost).toHaveBeenCalledWith(
      '/api/eval/harness/proposals/hp_web1/adopt',
      {},
    );
  });

  test('version history marks active and offers rollback', async () => {
    await openHarnessTab();
    await loadWorkspaceData();
    expect(container?.textContent).toContain('v2');
    expect(container?.textContent).toContain('生效中');
    const rollback = [...container!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('回滚'),
    );
    expect(rollback).toBeTruthy();
  });
});

// ── adapter attribution UI (task AF) ────────────────────────────────────────

describe('adapter attribution UI (task AF)', () => {
  test('observed turn rows carry an adapter version badge', async () => {
    state.isAdmin = true;
    apiGet.mockImplementation(async (url: string) => {
      if (url.includes('trigger/status')) return IDLE_TRIGGER;
      if (url.startsWith('/api/eval/datasets')) return { datasets: [] };
      if (url.includes('/api/eval/harness/workspaces'))
        return { workspaces: [] };
      if (url.includes('/api/eval/harness/proposals')) return { proposals: [] };
      if (url.includes('/api/eval/harness/versions')) return { versions: [] };
      if (url.includes('/api/eval/harness/lessons')) return { lessons: [] };
      if (url.includes('/api/eval/turns'))
        return {
          items: [
            { ...turnFixture, turnId: 'af-v1', adapterVersion: 1 },
            { ...turnFixture, turnId: 'af-v0', adapterVersion: 0 },
          ],
          total: 2,
        };
      return { runs: [], total: 0, items: [] };
    });
    await renderPage();
    const tab = [...container!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('真实对话'),
    );
    await act(async () => {
      tab?.click();
    });
    await act(async () => {});
    expect(container?.textContent).toContain('adapter v1');
    expect(container?.textContent).toContain('基线');
  });

  test('harness tab offers a workspace selector backed by the endpoint', async () => {
    state.isAdmin = true;
    apiGet.mockImplementation(async (url: string) => {
      if (url.includes('trigger/status')) return IDLE_TRIGGER;
      if (url.startsWith('/api/eval/datasets')) return { datasets: [] };
      if (url.includes('/api/eval/harness/evidence-status'))
        return {
          turnsSinceLastProposal: 0,
          lastProposalAt: null,
          activeVersion: 0,
        };
      if (url.includes('/api/eval/harness/evolve/status')) return EVOLVE_IDLE;
      if (url.includes('/api/eval/harness/workspaces'))
        return {
          workspaces: [
            {
              workspaceJid: 'feishu:ws-af@g.us',
              turnCount: 7,
              lastTurnAt: '2026-11-11T02:00:00Z',
              proposalCount: 1,
            },
          ],
        };
      if (url.includes('/api/eval/harness/proposals')) return { proposals: [] };
      if (url.includes('/api/eval/harness/versions')) return { versions: [] };
      if (url.includes('/api/eval/harness/lessons')) return { lessons: [] };
      return { runs: [], total: 0, items: [] };
    });
    await renderPage();
    const tab = [...container!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Harness 演化'),
    );
    await act(async () => {
      tab?.click();
    });
    await act(async () => {});
    const select = container?.querySelector('[data-harness-workspace-select]');
    expect(select).toBeTruthy();
    expect(select?.textContent).toContain('feishu:ws-af@g.us');
  });
});

// ── Harness probe UI (task AG, RSI Phase 2) ─────────────────────────────────

const ACCEPTANCE_FIXTURE = {
  workspaceJid: 'feishu:ws-ae@g.us',
  queries: [
    {
      id: 'q1',
      text: '把今天的接龙报名整理成表格',
      expectNotes: ['开头声明文件名与记录数'],
    },
  ],
  updatedAt: '2026-11-11T00:00:00Z',
};

const PROBE_REPORT_FIXTURE = {
  id: 'hpr_web1',
  proposalId: 'hp_web1',
  workspaceJid: 'feishu:ws-ae@g.us',
  baselineVersion: 1,
  verdict: 'adopt',
  roundsWon: 1,
  roundsLost: 0,
  roundsTied: 0,
  notesBaselineHit: 0,
  notesProposedHit: 1,
  rounds: [
    {
      queryId: 'q1',
      baselineText: '基线臂回答',
      proposedText: '提案臂回答',
      judgeDirect: {
        prefer: 'B',
        perNote: [{ note: '开头声明文件名与记录数', pick: 'B' }],
        reasoning: '提案先声明了文件名',
      },
      judgeSwapped: {
        prefer: 'A',
        perNote: [{ note: '开头声明文件名与记录数', pick: 'A' }],
        reasoning: 'swap 后仍选同一份',
      },
      noteHits: [{ note: '开头声明文件名与记录数', arm: 'proposed' }],
    },
  ],
  costUsd: null,
  model: 'glm-flash',
  createdAt: '2026-11-11T02:00:00Z',
};

describe('harness probe UI (task AG)', () => {
  beforeEach(() => {
    apiGet.mockImplementation(async (url: string) => {
      if (url.includes('trigger/status')) return IDLE_TRIGGER;
      if (url.startsWith('/api/eval/datasets')) return { datasets: [] };
      if (url.includes('/api/eval/harness/evidence-status'))
        return {
          turnsSinceLastProposal: 0,
          lastProposalAt: null,
          activeVersion: 0,
        };
      if (url.includes('/api/eval/harness/evolve/status')) return EVOLVE_IDLE;
      if (url.includes('/api/eval/harness/acceptance/'))
        return ACCEPTANCE_FIXTURE;
      if (url.includes('/api/eval/harness/probes'))
        return { probes: [PROBE_REPORT_FIXTURE] };
      if (url.includes('/api/eval/harness/proposals/'))
        return {
          ...PROPOSAL_DETAIL_FIXTURE,
          latestProbe: {
            id: 'hpr_web1',
            verdict: 'adopt',
            roundsWon: 1,
            roundsLost: 0,
            roundsTied: 0,
            notesBaselineHit: 0,
            notesProposedHit: 1,
            createdAt: '2026-11-11T02:00:00Z',
          },
        };
      if (url.includes('/api/eval/harness/proposals'))
        return { proposals: [PROPOSAL_FIXTURE] };
      if (url.includes('/api/eval/harness/versions')) return VERSIONS_FIXTURE;
      if (url.includes('/api/eval/harness/lessons')) return { lessons: [] };
      if (url.includes('/api/eval/harness/workspaces'))
        return { workspaces: [] };
      return { runs: [], total: 0, items: [] };
    });
  });

  async function openHarnessTab(): Promise<void> {
    state.isAdmin = true;
    await renderPage();
    const tab = [...container!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Harness 演化'),
    );
    await act(async () => {
      tab?.click();
    });
    await act(async () => {});
  }

  async function loadWorkspaceData(): Promise<void> {
    const input = container?.querySelector('[data-harness-workspace]');
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      nativeSetter?.call(input, 'feishu:ws-ae@g.us');
      (input as HTMLInputElement).dispatchEvent(
        new Event('input', { bubbles: true }),
      );
    });
    const load = [...container!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('加载'),
    );
    await act(async () => {
      load?.click();
    });
    await act(async () => {});
  }

  test('acceptance editor loads the stored set and saves via PUT', async () => {
    await openHarnessTab();
    await loadWorkspaceData();
    const textarea = container?.querySelector(
      '[data-harness-acceptance]',
    ) as HTMLTextAreaElement | null;
    expect(textarea).toBeTruthy();
    expect(textarea?.value).toContain('把今天的接龙报名整理成表格');

    // Edit (React-controlled textarea: native setter + input event), save.
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    const revised = JSON.stringify([
      {
        id: 'q1',
        text: '把今天的接龙报名整理成表格',
        expectNotes: ['开头声明文件名与记录数', '联系方式脱敏'],
      },
    ]);
    await act(async () => {
      setter?.call(textarea, revised);
      textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = [...container!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('保存验收集'),
    );
    expect(save).toBeTruthy();
    await act(async () => {
      save?.click();
    });
    await act(async () => {});
    expect(apiPut).toHaveBeenCalledWith(
      '/api/eval/harness/acceptance/feishu%3Aws-ae%40g.us',
      { queries: JSON.parse(revised) },
    );
    expect(container?.textContent).toContain('验收集已保存');
  });

  test('acceptance editor rejects invalid JSON locally before any request', async () => {
    await openHarnessTab();
    await loadWorkspaceData();
    const textarea = container?.querySelector(
      '[data-harness-acceptance]',
    ) as HTMLTextAreaElement | null;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      setter?.call(textarea, '{not json');
      textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = [...container!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('保存验收集'),
    );
    await act(async () => {
      save?.click();
    });
    await act(async () => {});
    expect(apiPut).not.toHaveBeenCalled();
    expect(container?.textContent).toMatch(/JSON/);
  });

  test('proposal detail shows the probe report: verdict, votes, arms, judge reasoning', async () => {
    await openHarnessTab();
    await loadWorkspaceData();
    const row = [...container!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('hp_web1'),
    );
    await act(async () => {
      row?.click();
    });
    await act(async () => {});
    const report = container?.querySelector('[data-harness-probe-report]');
    expect(report).toBeTruthy();
    expect(report?.textContent).toContain('建议采纳');
    expect(report?.textContent).toContain('基线臂回答');
    expect(report?.textContent).toContain('提案臂回答');
    expect(report?.textContent).toContain('提案先声明了文件名');
    expect(report?.textContent).toContain('swap 后仍选同一份');
    expect(report?.textContent).toContain('开头声明文件名与记录数');
    // The gap disclaimer keeps the admin from over-trusting the probe.
    expect(report?.textContent).toMatch(/无工具|无召回/);
  });

  test('no probe report area when the proposal has no probe yet', async () => {
    apiGet.mockImplementation(async (url: string) => {
      if (url.includes('trigger/status')) return IDLE_TRIGGER;
      if (url.startsWith('/api/eval/datasets')) return { datasets: [] };
      if (url.includes('/api/eval/harness/evidence-status'))
        return {
          turnsSinceLastProposal: 0,
          lastProposalAt: null,
          activeVersion: 0,
        };
      if (url.includes('/api/eval/harness/evolve/status')) return EVOLVE_IDLE;
      if (url.includes('/api/eval/harness/acceptance/'))
        return ACCEPTANCE_FIXTURE;
      if (url.includes('/api/eval/harness/probes')) return { probes: [] };
      if (url.includes('/api/eval/harness/proposals/'))
        return { ...PROPOSAL_DETAIL_FIXTURE, latestProbe: null };
      if (url.includes('/api/eval/harness/proposals'))
        return { proposals: [PROPOSAL_FIXTURE] };
      if (url.includes('/api/eval/harness/versions')) return VERSIONS_FIXTURE;
      if (url.includes('/api/eval/harness/lessons')) return { lessons: [] };
      if (url.includes('/api/eval/harness/workspaces'))
        return { workspaces: [] };
      return { runs: [], total: 0, items: [] };
    });
    await openHarnessTab();
    await loadWorkspaceData();
    const row = [...container!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('hp_web1'),
    );
    await act(async () => {
      row?.click();
    });
    await act(async () => {});
    expect(container?.querySelector('[data-harness-probe-report]')).toBeFalsy();
  });
});

// ── Harness Phase 3 UI (task AH): banner, one-click evolve, clone ───────────

const EVIDENCE_HOT = {
  turnsSinceLastProposal: 12,
  lastProposalAt: '2026-11-11T00:00:00Z',
  activeVersion: 1,
};

const EVIDENCE_COLD = {
  turnsSinceLastProposal: 3,
  lastProposalAt: '2026-11-11T00:00:00Z',
  activeVersion: 1,
};

const EVOLVE_RUNNING = {
  running: true,
  workspace: 'feishu:ws-ae@g.us',
  startedAt: 1,
  startedBy: 'user-admin',
  lines: ['proposing for feishu:ws-ae@g.us'],
  result: null,
};

describe('harness Phase 3 UI (task AH)', () => {
  function stubHarnessAH(evidence: unknown, evolve: unknown) {
    apiGet.mockImplementation(async (url: string) => {
      if (url.includes('trigger/status')) return IDLE_TRIGGER;
      if (url.startsWith('/api/eval/datasets')) return { datasets: [] };
      if (url.includes('/api/eval/harness/evidence-status')) return evidence;
      if (url.includes('/api/eval/harness/evolve/status')) return evolve;
      if (url.includes('/api/eval/harness/workspaces'))
        return { workspaces: [] };
      if (url.includes('/api/eval/harness/acceptance/')) return null;
      if (url.includes('/api/eval/harness/proposals/'))
        return { ...PROPOSAL_DETAIL_FIXTURE, latestProbe: null };
      if (url.includes('/api/eval/harness/proposals'))
        return { proposals: [PROPOSAL_FIXTURE] };
      if (url.includes('/api/eval/harness/versions')) return VERSIONS_FIXTURE;
      if (url.includes('/api/eval/harness/lessons')) return { lessons: [] };
      return { runs: [], total: 0, items: [] };
    });
  }

  async function openHarnessTab(): Promise<void> {
    state.isAdmin = true;
    await renderPage();
    const tab = [...container!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Harness 演化'),
    );
    await act(async () => {
      tab?.click();
    });
    await act(async () => {});
  }

  async function loadWorkspaceData(): Promise<void> {
    const input = container?.querySelector('[data-harness-workspace]');
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      nativeSetter?.call(input, 'feishu:ws-ae@g.us');
      (input as HTMLInputElement).dispatchEvent(
        new Event('input', { bubbles: true }),
      );
    });
    const load = [...container!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('加载'),
    );
    await act(async () => {
      load?.click();
    });
    await act(async () => {});
  }

  test('≥10 new evidence turns surface the banner with the count and propose button', async () => {
    stubHarnessAH(EVIDENCE_HOT, EVOLVE_IDLE);
    await openHarnessTab();
    await loadWorkspaceData();
    const banner = container?.querySelector('[data-harness-evidence-banner]');
    expect(banner).toBeTruthy();
    expect(banner?.textContent).toContain('12');
    expect(banner?.textContent).toMatch(/新证据/);

    apiPost.mockResolvedValueOnce({
      accepted: true,
      workspace: 'feishu:ws-ae@g.us',
    });
    const propose = [...container!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('生成提案'),
    );
    expect(propose).toBeTruthy();
    await act(async () => {
      propose?.click();
    });
    await act(async () => {});
    expect(apiPost).toHaveBeenCalledWith('/api/eval/harness/evolve/trigger', {
      workspace: 'feishu:ws-ae@g.us',
    });
  });

  test('below the threshold the banner stays hidden', async () => {
    stubHarnessAH(EVIDENCE_COLD, EVOLVE_IDLE);
    await openHarnessTab();
    await loadWorkspaceData();
    expect(
      container?.querySelector('[data-harness-evidence-banner]'),
    ).toBeFalsy();
  });

  test('a running evolve disables the propose button and shows the log tail', async () => {
    stubHarnessAH(EVIDENCE_HOT, EVOLVE_RUNNING);
    await openHarnessTab();
    await loadWorkspaceData();
    const propose = [...container!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('生成提案'),
    );
    expect(propose).toBeTruthy();
    expect((propose as HTMLButtonElement).disabled).toBe(true);
    const status = container?.querySelector('[data-harness-evolve-status]');
    expect(status).toBeTruthy();
    expect(status?.textContent).toContain('proposing for feishu:ws-ae@g.us');
  });

  test('version rows clone into another workspace via the proposal gate', async () => {
    stubHarnessAH(EVIDENCE_COLD, EVOLVE_IDLE);
    await openHarnessTab();
    await loadWorkspaceData();
    expect(container?.textContent).toContain('版本历史');

    const cloneEntry = [...container!.querySelectorAll('button')].find(
      (button) => button.textContent?.includes('克隆到'),
    );
    expect(cloneEntry).toBeTruthy();
    await act(async () => {
      cloneEntry?.click();
    });
    await act(async () => {});

    const input = container?.querySelector(
      '[data-harness-clone-input]',
    ) as HTMLInputElement | null;
    expect(input).toBeTruthy();
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      nativeSetter?.call(input, 'feishu:ws-target@g.us');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    apiPost.mockResolvedValueOnce({
      ok: true,
      proposal: { id: 'hp_clone1', workspaceJid: 'feishu:ws-target@g.us' },
    });
    const confirm = [...container!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('确认克隆'),
    );
    expect(confirm).toBeTruthy();
    await act(async () => {
      confirm?.click();
    });
    await act(async () => {});

    // VERSIONS_FIXTURE lists hv_2 first → the clone targets that row.
    expect(apiPost).toHaveBeenCalledWith(
      '/api/eval/harness/versions/hv_2/clone?workspace=feishu%3Aws-ae%40g.us',
      { targetWorkspace: 'feishu:ws-target@g.us' },
    );
    expect(container?.textContent).toContain('hp_clone1');
  });
});
