import { describe, expect, test, vi } from 'vitest';

import {
  buildProbePlan,
  completeWithRetry,
  parseProbeArgs,
} from '../scripts/eval-harness-probe.js';
import type {
  HarnessAcceptanceSetRecord,
  HarnessProposalRecord,
} from '../src/eval-store.js';

// ── parseProbeArgs ──────────────────────────────────────────────────────────

describe('parseProbeArgs', () => {
  test('parses workspace, proposal, and dry-run', () => {
    expect(
      parseProbeArgs([
        '--workspace',
        'feishu:1@g.us',
        '--proposal',
        'hp_abc',
        '--dry-run',
      ]),
    ).toEqual({
      workspace: 'feishu:1@g.us',
      proposal: 'hp_abc',
      dryRun: true,
    });
  });

  test('defaults dry-run to false', () => {
    expect(parseProbeArgs(['--workspace', 'w', '--proposal', 'hp_1'])).toEqual({
      workspace: 'w',
      proposal: 'hp_1',
      dryRun: false,
    });
  });

  test('rejects missing workspace or proposal', () => {
    expect(parseProbeArgs(['--proposal', 'hp_1'])).toBeNull();
    expect(parseProbeArgs(['--workspace', 'w'])).toBeNull();
    expect(parseProbeArgs(['--dry-run'])).toBeNull();
    expect(parseProbeArgs([])).toBeNull();
  });

  test('rejects unknown flags', () => {
    expect(
      parseProbeArgs(['--workspace', 'w', '--proposal', 'p', '--x']),
    ).toBeNull();
  });
});

// ── buildProbePlan (guardrails + dry-run payload) ───────────────────────────

describe('buildProbePlan', () => {
  const queries = [
    {
      id: 'q1',
      text: '把今天的接龙报名整理成表格',
      expectNotes: ['开头声明文件名与记录数', '联系方式脱敏'],
    },
    { id: 'q2', text: '总结本周接龙', expectNotes: ['输出条目数'] },
  ];

  function proposal(
    overrides: Partial<
      Pick<HarnessProposalRecord, 'status' | 'keepBase' | 'workspaceJid'>
    > = {},
  ): HarnessProposalRecord {
    return {
      id: 'hp_1',
      workspaceJid: overrides.workspaceJid ?? 'ws@g.us',
      status: overrides.status ?? 'pending',
      keepBase: overrides.keepBase ?? false,
      adapterMd: '# Adapter\n声明文件名',
      diff: null,
      rationale: 'r',
      evidence: [],
      evidenceCount: 0,
      baselineVersion: 1,
      model: 'glm-flash',
      promptHash: 'h',
      createdAt: '2026-11-11T00:00:00Z',
      decidedAt: null,
      decidedBy: null,
    };
  }

  const acceptanceSet: HarnessAcceptanceSetRecord = {
    workspaceJid: 'ws@g.us',
    queries,
    updatedAt: '2026-11-11T00:00:00Z',
  };

  test('a valid pending proposal plans 2 generations + 4 judges per query', () => {
    const plan = buildProbePlan({
      proposal: proposal(),
      acceptanceSet,
      activeVersion: 2,
      workspace: 'ws@g.us',
    });
    expect(plan).not.toHaveProperty('kind');
    expect(plan).toMatchObject({
      proposalId: 'hp_1',
      workspaceJid: 'ws@g.us',
      baselineVersion: 2,
      proposedVersion: 3,
      queryCount: 2,
      generations: 4,
      judgeCalls: 8,
      totalCalls: 12,
    });
  });

  test('missing active adapter (v0) plans a baseline arm without a block', () => {
    const plan = buildProbePlan({
      proposal: proposal(),
      acceptanceSet,
      activeVersion: 0,
      workspace: 'ws@g.us',
    });
    expect(plan).toMatchObject({ baselineVersion: 0, proposedVersion: 1 });
  });

  test('rejects an unknown proposal', () => {
    expect(
      buildProbePlan({
        proposal: null,
        acceptanceSet,
        activeVersion: 0,
        workspace: 'ws@g.us',
      }),
    ).toEqual({ kind: 'proposal_not_found' });
  });

  test('rejects a proposal that is no longer pending', () => {
    expect(
      buildProbePlan({
        proposal: proposal({ status: 'adopted' }),
        acceptanceSet,
        activeVersion: 0,
        workspace: 'ws@g.us',
      }),
    ).toEqual({ kind: 'proposal_not_pending', status: 'adopted' });
    expect(
      buildProbePlan({
        proposal: proposal({ status: 'invalid' }),
        acceptanceSet,
        activeVersion: 0,
        workspace: 'ws@g.us',
      }),
    ).toEqual({ kind: 'proposal_not_pending', status: 'invalid' });
  });

  test('rejects a workspace mismatch between CLI flag and proposal', () => {
    expect(
      buildProbePlan({
        proposal: proposal({ workspaceJid: 'other@g.us' }),
        acceptanceSet,
        activeVersion: 0,
        workspace: 'ws@g.us',
      }),
    ).toEqual({ kind: 'proposal_workspace_mismatch' });
  });

  test('rejects a KEEP_BASE proposal (both arms would be identical)', () => {
    expect(
      buildProbePlan({
        proposal: proposal({ keepBase: true }),
        acceptanceSet,
        activeVersion: 0,
        workspace: 'ws@g.us',
      }),
    ).toEqual({ kind: 'keep_base_proposal' });
  });

  test('rejects a missing acceptance set', () => {
    expect(
      buildProbePlan({
        proposal: proposal(),
        acceptanceSet: null,
        activeVersion: 0,
        workspace: 'ws@g.us',
      }),
    ).toEqual({ kind: 'acceptance_set_missing' });
  });

  test('rejects an acceptance set that fails validation (>10 queries)', () => {
    const tooMany: HarnessAcceptanceSetRecord = {
      workspaceJid: 'ws@g.us',
      queries: Array.from({ length: 11 }, (_, i) => ({
        id: `q${i}`,
        text: `问题 ${i}`,
        expectNotes: ['要点'],
      })),
      updatedAt: '2026-11-11T00:00:00Z',
    };
    const rejected = buildProbePlan({
      proposal: proposal(),
      acceptanceSet: tooMany,
      activeVersion: 0,
      workspace: 'ws@g.us',
    });
    expect(rejected).toMatchObject({ kind: 'acceptance_set_invalid' });
    expect(rejected.issues?.length).toBeGreaterThan(0);
  });
});

// ── completeWithRetry (task AG follow-up: mid-run endpoint disconnects) ────

describe('completeWithRetry', () => {
  test('returns on the first success without sleeping', async () => {
    const sleeps: number[] = [];
    const complete = vi.fn(async () => 'ok');
    const result = await completeWithRetry({ model: 'm', complete }, 'p', {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result).toBe('ok');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  test('retries through transient failures with backoff, then succeeds', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const complete = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new TypeError('fetch failed');
      return 'recovered';
    });
    const result = await completeWithRetry({ model: 'm', complete }, 'p', {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result).toBe('recovered');
    expect(complete).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([2000, 5000]);
  });

  test('exhausts retries and rethrows the last error', async () => {
    const sleeps: number[] = [];
    const complete = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(
      completeWithRetry({ model: 'm', complete }, 'p', {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    ).rejects.toThrow('fetch failed');
    // default 3 retries → 4 attempts, 3 backoffs
    expect(complete).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([2000, 5000, 10000]);
  });
});
