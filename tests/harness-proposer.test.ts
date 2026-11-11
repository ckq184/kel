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
