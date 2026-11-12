import { describe, expect, test } from 'vitest';

import {
  PROPOSER_PROMPT_VERSION,
  EXCERPT_MAX_CHARS,
  sanitizeObsTurn,
  buildEvidence,
  proposerPrompt,
  proposerPromptHash,
  parseProposerResponse,
  reflectPrompt,
  parseReflectResponse,
  buildUnifiedDiff,
  clusterTurns,
  pickNeighborLessons,
  type EvidenceTurn,
} from '../src/harness-proposer.js';

// ── sanitizeObsTurn (leak line of defense, by construction) ─────────────────

describe('sanitizeObsTurn', () => {
  test('keeps only the whitelisted fields and never judge internals', () => {
    const sanitized = sanitizeObsTurn({
      turnId: 't1',
      workspaceJid: 'ws@g.us',
      inputText: '帮我算报销',
      outputText: '共 1200 元',
      channel: 'feishu',
      createdAt: '2026-11-11T00:00:00Z',
      judgeUsed: 1,
      judgeReasoning: 'CONFIDENTIAL judge reasoning',
      judgeError: null,
      judgeModel: 'glm-flash',
      judgePromptHash: 'deadbeef',
      costUsd: 0.01,
    });
    expect(sanitized).toEqual({
      turnId: 't1',
      inputText: '帮我算报销',
      outputText: '共 1200 元',
      channel: 'feishu',
      createdAt: '2026-11-11T00:00:00Z',
    });
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain('judge');
    expect(serialized).not.toContain('CONFIDENTIAL');
  });

  test('tolerates null input/output text', () => {
    const sanitized = sanitizeObsTurn({
      turnId: 't2',
      inputText: null,
      outputText: null,
      createdAt: '2026-11-11T00:00:00Z',
    });
    expect(sanitized.inputText).toBe('');
    expect(sanitized.outputText).toBe('');
  });
});

// ── evidence assembly ───────────────────────────────────────────────────────

describe('buildEvidence', () => {
  const turns: EvidenceTurn[] = [
    {
      turnId: 't1',
      inputText: '算报销',
      outputText: '1200 元',
      channel: 'feishu',
      createdAt: '2026-11-10T00:00:00Z',
    },
    {
      turnId: 't2',
      inputText: '算报销（另一问法）',
      outputText: '先列清单',
      channel: 'web',
      createdAt: '2026-11-10T01:00:00Z',
    },
  ];

  test('embeds turns, the current adapter, and lessons', () => {
    const evidence = buildEvidence({
      workspaceJid: 'ws@g.us',
      turns,
      currentAdapterMd: '# 当前 adapter\n先做 A',
      lessons: [
        {
          cue: '财务问题',
          lesson: '确认币种',
          evidence: '3 turns',
          confidence: 'medium',
        },
      ],
    });
    expect(evidence).toContain('t1');
    expect(evidence).toContain('算报销');
    expect(evidence).toContain('先做 A');
    expect(evidence).toContain('确认币种');
  });

  test('marks a fresh workspace when there is no adapter yet', () => {
    const evidence = buildEvidence({
      workspaceJid: 'ws@g.us',
      turns,
      currentAdapterMd: null,
      lessons: [],
    });
    expect(evidence).toMatch(/no adapter yet|baseline harness/i);
  });

  test('truncates long turn text to the excerpt cap', () => {
    const long: EvidenceTurn[] = [
      {
        turnId: 't-long',
        inputText: 'x'.repeat(EXCERPT_MAX_CHARS + 500),
        outputText: 'y'.repeat(EXCERPT_MAX_CHARS + 500),
        channel: 'web',
        createdAt: '2026-11-10T00:00:00Z',
      },
    ];
    const evidence = buildEvidence({
      workspaceJid: 'ws@g.us',
      turns: long,
      currentAdapterMd: null,
      lessons: [],
    });
    expect(evidence).not.toContain('x'.repeat(EXCERPT_MAX_CHARS + 1));
  });
});

// ── proposer prompt + parse ─────────────────────────────────────────────────

describe('proposerPrompt', () => {
  test('carries the discipline markers (divergence first, cite turns, KEEP_BASE)', () => {
    const prompt = proposerPrompt('EVIDENCE-BODY');
    expect(prompt).toContain('EVIDENCE-BODY');
    expect(prompt).toMatch(/diverge|divergence|分歧/i);
    expect(prompt).toMatch(/turn[_ ]?id/i);
    expect(prompt).toMatch(/keep_base/i);
    expect(prompt).toContain(PROPOSER_PROMPT_VERSION);
  });

  test('prompt hash is stable and short', () => {
    const a = proposerPromptHash();
    const b = proposerPromptHash();
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });
});

describe('parseProposerResponse', () => {
  test('parses a clean JSON adopt proposal', () => {
    const parsed = parseProposerResponse(
      JSON.stringify({
        keep_base: false,
        adapter_md: '# Adapter\n\n先确认币种。',
        rationale: '三个 turn 一致漏币种。',
        evidence: [
          {
            turn_id: 't1',
            input_excerpt: '算报销',
            output_excerpt: '1200 元',
            why: '未确认币种',
          },
        ],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.keepBase).toBe(false);
    expect(parsed!.adapterMd).toContain('币种');
    expect(parsed!.evidence[0].turnId).toBe('t1');
  });

  test('parses JSON wrapped in a markdown fence', () => {
    const parsed = parseProposerResponse(
      '```json\n' +
        JSON.stringify({
          keep_base: true,
          adapter_md: '',
          rationale: '证据不足，维持现状。',
          evidence: [],
        }) +
        '\n```',
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.keepBase).toBe(true);
    expect(parsed!.adapterMd).toBe('');
  });

  test('returns null on missing rationale', () => {
    expect(
      parseProposerResponse(
        JSON.stringify({ keep_base: false, adapter_md: 'x', evidence: [] }),
      ),
    ).toBeNull();
  });

  test('returns null when cited evidence lacks a turn id', () => {
    expect(
      parseProposerResponse(
        JSON.stringify({
          keep_base: false,
          adapter_md: 'x',
          rationale: 'r',
          evidence: [{ why: 'no turn cited' }],
        }),
      ),
    ).toBeNull();
  });

  test('returns null on non-JSON garbage', () => {
    expect(parseProposerResponse('我觉得挺好的')).toBeNull();
  });
});

// ── reflect (lesson distillation) ───────────────────────────────────────────

describe('reflectPrompt / parseReflectResponse', () => {
  test('reflect prompt demands the three mandatory fields', () => {
    const prompt = reflectPrompt({
      adapterMd: '# A',
      rationale: 'r',
      turns: [
        {
          turnId: 't1',
          inputText: 'i',
          outputText: 'o',
          channel: 'web',
          createdAt: '2026-11-10T00:00:00Z',
        },
      ],
    });
    expect(prompt).toMatch(/cue/);
    expect(prompt).toMatch(/lesson/);
    expect(prompt).toMatch(/evidence/);
    expect(prompt).toMatch(/NO_ENTRY/i);
  });

  test('parses a complete lesson', () => {
    const lesson = parseReflectResponse(
      JSON.stringify({
        cue: '财务类金额问题',
        lesson: '要求先确认币种',
        evidence: 't1/t2 均漏币种',
        confidence: 'medium',
      }),
    );
    expect(lesson).toEqual({
      cue: '财务类金额问题',
      lesson: '要求先确认币种',
      evidence: 't1/t2 均漏币种',
      confidence: 'medium',
    });
  });

  test('missing any mandatory field yields null (宁缺毋滥)', () => {
    expect(
      parseReflectResponse(
        JSON.stringify({ cue: 'c', lesson: 'l', evidence: '' }),
      ),
    ).toBeNull();
    expect(parseReflectResponse('not json')).toBeNull();
  });

  test('confidence is optional', () => {
    const lesson = parseReflectResponse(
      JSON.stringify({ cue: 'c', lesson: 'l', evidence: 'e' }),
    );
    expect(lesson).toEqual({
      cue: 'c',
      lesson: 'l',
      evidence: 'e',
      confidence: null,
    });
  });
});

// ── unified diff ────────────────────────────────────────────────────────────

describe('buildUnifiedDiff', () => {
  test('marks removals and additions against a baseline', () => {
    const diff = buildUnifiedDiff('# A\nkeep\n# B', '# A\nkeep\n# C');
    expect(diff).toContain('- # B');
    expect(diff).toContain('+ # C');
    expect(diff).toContain('  keep');
  });

  test('fresh adapter diff is all additions', () => {
    const diff = buildUnifiedDiff(null, '# brand new');
    expect(diff).toContain('+ # brand new');
    expect(diff).not.toMatch(/^- /);
  });
});

// ── Neighbor lesson matching (task AH, RSI Phase 3) ─────────────────────────
//
// hermit's transferability sell: lessons distilled in one workspace can seed
// proposals in another. Matching stays lexical on purpose (runtime deps are
// frozen; neither probe nor evolve depends on an embedder).

describe('pickNeighborLessons', () => {
  const pool = [
    {
      workspaceJid: 'ws-a@g.us',
      cue: '财务报销 金额计算',
      lesson: '先确认币种',
      evidence: '3 turns',
      confidence: 'medium',
    },
    {
      workspaceJid: 'ws-b@g.us',
      cue: '报销 流程 审批',
      lesson: '列出审批人',
      evidence: '2 turns',
      confidence: null,
    },
    {
      workspaceJid: 'ws-self@g.us',
      cue: '财务报销',
      lesson: '本 workspace 已注入的 lesson',
      evidence: 'x',
      confidence: null,
    },
    {
      workspaceJid: 'ws-c@g.us',
      cue: '完全无关的天气话题',
      lesson: '无关',
      evidence: 'x',
      confidence: null,
    },
  ];

  test('ranks cross-workspace lessons by cue/turn token overlap, top-3', () => {
    const picks = pickNeighborLessons({
      selfJid: 'ws-self@g.us',
      selfTurnTexts: ['帮我算一下报销的金额'],
      allLessons: pool,
    });
    // 财务报销/金额计算 shares two 2-grams with the turn; 报销流程审批 shares
    // one; weather shares none and is dropped; self-workspace never returns.
    expect(picks.map((pick) => pick.workspaceJid)).toEqual([
      'ws-a@g.us',
      'ws-b@g.us',
    ]);
    expect(picks[0]).toMatchObject({ lesson: '先确认币种', score: 2 });
    expect(picks[1]).toMatchObject({ lesson: '列出审批人', score: 1 });
  });

  test('Chinese matching rides on 2-grams without any shared word', () => {
    const picks = pickNeighborLessons({
      selfJid: 'ws-self@g.us',
      selfTurnTexts: ['整理接龙报名成表格'],
      allLessons: [
        {
          workspaceJid: 'ws-d@g.us',
          cue: '接龙报名整理',
          lesson: '开头声明条数',
          evidence: '1 turn',
          confidence: null,
        },
        {
          workspaceJid: 'ws-e@g.us',
          cue: '天气查询',
          lesson: '附带数据来源',
          evidence: '1 turn',
          confidence: null,
        },
      ],
    });
    expect(picks.map((pick) => pick.workspaceJid)).toEqual(['ws-d@g.us']);
  });

  test('English cues match on whole lowercase words', () => {
    const picks = pickNeighborLessons({
      selfJid: 'ws-self@g.us',
      selfTurnTexts: ['please check the Invoice total in USD'],
      allLessons: [
        {
          workspaceJid: 'ws-f@g.us',
          cue: 'invoice currency',
          lesson: 'state the currency',
          evidence: '2 turns',
          confidence: null,
        },
        {
          workspaceJid: 'ws-g@g.us',
          cue: 'refund policy',
          lesson: 'cite the policy doc',
          evidence: '1 turn',
          confidence: null,
        },
      ],
    });
    expect(picks.map((pick) => pick.workspaceJid)).toEqual(['ws-f@g.us']);
  });

  test('empty turn texts, empty pool, or all-self pool yield []', () => {
    expect(
      pickNeighborLessons({
        selfJid: 'ws-self@g.us',
        selfTurnTexts: [],
        allLessons: pool,
      }),
    ).toEqual([]);
    expect(
      pickNeighborLessons({
        selfJid: 'ws-self@g.us',
        selfTurnTexts: ['报销'],
        allLessons: [],
      }),
    ).toEqual([]);
    expect(
      pickNeighborLessons({
        selfJid: 'ws-self@g.us',
        selfTurnTexts: ['财务报销'],
        allLessons: pool.filter((l) => l.workspaceJid === 'ws-self@g.us'),
      }),
    ).toEqual([]);
  });

  test('limit caps the result set at the requested size', () => {
    const picks = pickNeighborLessons({
      selfJid: 'ws-self@g.us',
      selfTurnTexts: ['帮我算一下报销的金额，顺便走一下审批流程'],
      allLessons: pool,
      limit: 1,
    });
    expect(picks).toHaveLength(1);
  });
});

// ── Evidence clustering (task AH, RSI Phase 3) ──────────────────────────────
//
// The proposer prompt already ranks divergence first; clustering pre-computes
// the grouping so similar-situation turns sit next to each other with an
// input-variance label. Heuristic signal only — never a gate.

describe('clusterTurns', () => {
  const t = (
    id: string,
    channel: string,
    createdAt: string,
    inputText: string,
  ): EvidenceTurn => ({
    turnId: id,
    inputText,
    outputText: `out-${id}`,
    channel,
    createdAt,
  });

  test('splits on a >30-minute gap; merges similar inputs inside a window', () => {
    const clusters = clusterTurns([
      t('t1', 'feishu', '2026-11-12T10:00:00Z', '算报销'),
      t('t2', 'feishu', '2026-11-12T10:20:00Z', '算报销（另一问法）'),
      t('t3', 'feishu', '2026-11-12T12:00:00Z', '算报销'),
    ]);
    expect(clusters.map((c) => c.clusterId)).toEqual(['c1', 'c2']);
    expect(clusters[0].turns.map((turn) => turn.turnId)).toEqual(['t1', 't2']);
    expect(clusters[1].turns.map((turn) => turn.turnId)).toEqual(['t3']);
  });

  test('different channels never share a cluster', () => {
    const clusters = clusterTurns([
      t('t1', 'feishu', '2026-11-12T10:00:00Z', '算报销'),
      t('t2', 'web', '2026-11-12T10:05:00Z', '算报销'),
    ]);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].turns.map((turn) => turn.turnId)).toEqual(['t1']);
    expect(clusters[1].turns.map((turn) => turn.turnId)).toEqual(['t2']);
    expect(clusters[0].inputVariance).toBe(0);
  });

  test('dissimilar inputs split even inside one time window', () => {
    const clusters = clusterTurns([
      t('t1', 'feishu', '2026-11-12T10:00:00Z', '算报销'),
      t('t2', 'feishu', '2026-11-12T10:10:00Z', '总结周报'),
      t('t3', 'feishu', '2026-11-12T10:15:00Z', '算报销怎么算'),
    ]);
    // t1/t3 share the 算报销 vocabulary; t2 is a different task.
    expect(clusters).toHaveLength(2);
    expect(clusters[0].turns.map((turn) => turn.turnId)).toEqual(['t1', 't3']);
    expect(clusters[1].turns.map((turn) => turn.turnId)).toEqual(['t2']);
  });

  test('inputVariance: 0 for singletons and identical inputs, 0-1 range', () => {
    const single = clusterTurns([
      t('t1', 'web', '2026-11-12T10:00:00Z', '算报销'),
    ]);
    expect(single[0].inputVariance).toBe(0);

    const identical = clusterTurns([
      t('t1', 'web', '2026-11-12T10:00:00Z', '算报销'),
      t('t2', 'web', '2026-11-12T10:05:00Z', '算报销'),
    ]);
    expect(identical[0].inputVariance).toBe(0);

    const paraphrase = clusterTurns([
      t('t1', 'web', '2026-11-12T10:00:00Z', '算报销'),
      t('t2', 'web', '2026-11-12T10:05:00Z', '帮我算一下报销'),
    ]);
    expect(paraphrase[0].inputVariance).toBeGreaterThan(0);
    expect(paraphrase[0].inputVariance).toBeLessThanOrEqual(1);
  });

  test('accepts newest-first input; output is lossless and time-ascending', () => {
    const turns = [
      t('t3', 'web', '2026-11-12T12:00:00Z', '总结周报'),
      t('t1', 'web', '2026-11-12T10:00:00Z', '算报销'),
      t('t2', 'web', '2026-11-12T10:05:00Z', '算报销'),
    ];
    const clusters = clusterTurns(turns);
    const seen = clusters.flatMap((c) => c.turns.map((turn) => turn.turnId));
    expect([...seen].sort()).toEqual(['t1', 't2', 't3']);
    expect(seen.indexOf('t1')).toBeLessThan(seen.indexOf('t2'));
  });

  test('empty input yields no clusters', () => {
    expect(clusterTurns([])).toEqual([]);
  });
});

// ── buildEvidence optional Phase 3 sections (task AH) ───────────────────────

describe('buildEvidence with clusters / neighbor lessons (task AH)', () => {
  const turns: EvidenceTurn[] = [
    {
      turnId: 't1',
      inputText: '算报销',
      outputText: '1200 元',
      channel: 'feishu',
      createdAt: '2026-11-10T00:00:00Z',
    },
  ];

  test('neighbor lessons render with a caution disclaimer and origin jid', () => {
    const evidence = buildEvidence({
      workspaceJid: 'ws@g.us',
      turns,
      currentAdapterMd: null,
      lessons: [],
      neighborLessons: [
        {
          workspaceJid: 'ws-other@g.us',
          cue: '财务报销',
          lesson: '先确认币种',
          evidence: '3 turns',
          confidence: 'medium',
          score: 2,
        },
      ],
    });
    expect(evidence).toContain('ws-other@g.us');
    expect(evidence).toContain('先确认币种');
    expect(evidence).toMatch(/other workspace/i);
    expect(evidence).toMatch(/may not|caution|谨慎/i);
  });

  test('an empty neighbor list keeps the legacy evidence shape', () => {
    const withEmpty = buildEvidence({
      workspaceJid: 'ws@g.us',
      turns,
      currentAdapterMd: null,
      lessons: [],
      neighborLessons: [],
    });
    const without = buildEvidence({
      workspaceJid: 'ws@g.us',
      turns,
      currentAdapterMd: null,
      lessons: [],
    });
    expect(withEmpty).toBe(without);
  });

  test('clusters regroup the turns section with a variance label', () => {
    const clustered = clusterTurns([
      { ...turns[0] },
      {
        turnId: 't2',
        inputText: '算报销（另一问法）',
        outputText: '先列清单',
        channel: 'feishu',
        createdAt: '2026-11-10T00:10:00Z',
      },
    ]);
    const evidence = buildEvidence({
      workspaceJid: 'ws@g.us',
      turns: clustered.flatMap((c) => c.turns),
      currentAdapterMd: null,
      lessons: [],
      clusters: clustered,
    });
    expect(evidence).toContain('cluster');
    expect(evidence).toMatch(/input variance/i);
    expect(evidence).toContain('t1');
    expect(evidence).toContain('t2');
  });

  test('without clusters the turns section stays flat (legacy callers)', () => {
    const evidence = buildEvidence({
      workspaceJid: 'ws@g.us',
      turns,
      currentAdapterMd: null,
      lessons: [],
    });
    expect(evidence).not.toMatch(/cluster/i);
    expect(evidence).toContain('### turn_id: t1');
  });
});
