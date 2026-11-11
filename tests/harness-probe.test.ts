import { describe, expect, test } from 'vitest';

import {
  ACCEPTANCE_QUERIES_MAX,
  ACCEPTANCE_QUERIES_MIN,
  aggregateVerdict,
  blindJudgePrompt,
  blindJudgePromptHash,
  parseBlindJudge,
  probeArmPrompt,
  probeArmPromptHash,
  resolveRound,
  swapLabels,
  validateAcceptanceSet,
  type BlindJudgeVerdict,
} from '../src/harness-probe.js';

// ── validateAcceptanceSet ───────────────────────────────────────────────────

describe('validateAcceptanceSet', () => {
  const valid = [
    {
      id: 'q1',
      text: '把今天的接龙报名整理成表格',
      expectNotes: ['开头声明文件名与记录数', '联系方式脱敏'],
    },
    { id: 'q2', text: '总结本周接龙', expectNotes: ['输出条目数'] },
  ];

  test('accepts a well-formed set', () => {
    expect(validateAcceptanceSet(valid)).toEqual({ ok: true, issues: [] });
  });

  test('rejects non-array input', () => {
    expect(validateAcceptanceSet('nope').ok).toBe(false);
    expect(validateAcceptanceSet(null).ok).toBe(false);
    expect(validateAcceptanceSet({ queries: valid }).ok).toBe(false);
  });

  test(`enforces the ${ACCEPTANCE_QUERIES_MIN}–${ACCEPTANCE_QUERIES_MAX} size window`, () => {
    expect(validateAcceptanceSet([]).ok).toBe(false);
    const tooMany = Array.from(
      { length: ACCEPTANCE_QUERIES_MAX + 1 },
      (_, i) => ({
        id: `q${i}`,
        text: `问题 ${i}`,
        expectNotes: ['要点'],
      }),
    );
    expect(validateAcceptanceSet(tooMany).ok).toBe(false);
    const atMax = tooMany.slice(0, ACCEPTANCE_QUERIES_MAX);
    expect(validateAcceptanceSet(atMax).ok).toBe(true);
  });

  test('rejects empty/whitespace text, empty id, empty expectNotes', () => {
    expect(validateAcceptanceSet([{ ...valid[0], text: '   ' }]).ok).toBe(
      false,
    );
    expect(validateAcceptanceSet([{ ...valid[0], id: '' }]).ok).toBe(false);
    expect(validateAcceptanceSet([{ ...valid[0], expectNotes: [] }]).ok).toBe(
      false,
    );
    expect(
      validateAcceptanceSet([{ ...valid[0], expectNotes: ['  '] }]).ok,
    ).toBe(false);
  });

  test('rejects duplicate ids and malformed entries', () => {
    expect(validateAcceptanceSet([valid[0], { ...valid[0] }]).ok).toBe(false);
    expect(validateAcceptanceSet([valid[0], 'x']).ok).toBe(false);
    expect(
      validateAcceptanceSet([{ id: 'q1', text: 't', expectNotes: [42] }]).ok,
    ).toBe(false);
    expect(
      validateAcceptanceSet([
        { id: 'q1', text: 't', expectNotes: ['a'], extra: true },
      ]).ok,
    ).toBe(true);
  });

  test('issues are human-readable strings for the Web editor', () => {
    const result = validateAcceptanceSet([
      { id: 'q1', text: '', expectNotes: [] },
    ]);
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.every((issue) => typeof issue === 'string')).toBe(
      true,
    );
  });
});

// ── probeArmPrompt ──────────────────────────────────────────────────────────

describe('probeArmPrompt', () => {
  test('embeds the adapter block and the acceptance question', () => {
    const prompt = probeArmPrompt({
      question: '总结本周接龙',
      adapterBlock:
        '<!-- ckqclaw-harness-adapter v1 -->\n# Workspace Harness Adapter\n先声明文件名\n<!-- /ckqclaw-harness-adapter -->',
    });
    expect(prompt).toContain('ckqclaw-harness-adapter v1');
    expect(prompt).toContain('Workspace Harness Adapter');
    expect(prompt).toContain('总结本周接龙');
    // The arm prompt version keeps runs attributable (proposer precedent).
    expect(prompt).toMatch(/probe prompt version: harness-probe-v\d+/i);
  });

  test('omits the adapter section entirely when the arm has no adapter (v0 baseline)', () => {
    const prompt = probeArmPrompt({
      question: '总结本周接龙',
      adapterBlock: '',
    });
    expect(prompt).not.toContain('ckqclaw-harness-adapter');
    expect(prompt).not.toContain('Workspace Harness Adapter');
    expect(prompt).toContain('总结本周接龙');
  });

  test('prompt hash is stable and versioned', () => {
    expect(probeArmPromptHash()).toBe(probeArmPromptHash());
    expect(probeArmPromptHash()).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ── blindJudgePrompt ────────────────────────────────────────────────────────

describe('blindJudgePrompt', () => {
  test('carries question, notes, both replies, JSON contract and the length-bias guard', () => {
    const prompt = blindJudgePrompt({
      question: '总结本周接龙',
      expectNotes: ['开头声明文件名与记录数', '联系方式脱敏'],
      replyA: '回答 A',
      replyB: '回答 B',
    });
    expect(prompt).toContain('总结本周接龙');
    expect(prompt).toContain('开头声明文件名与记录数');
    expect(prompt).toContain('联系方式脱敏');
    expect(prompt).toContain('回答 A');
    expect(prompt).toContain('回答 B');
    expect(prompt).toMatch(/"prefer"\s*:\s*<A\|B\|tie>/);
    expect(prompt).toMatch(/"per_note"/);
    expect(prompt).toMatch(/length/i);
    expect(prompt).toMatch(/blind judge prompt version: /i);
  });

  test('prompt hash is stable', () => {
    expect(blindJudgePromptHash()).toBe(blindJudgePromptHash());
    expect(blindJudgePromptHash()).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ── parseBlindJudge ─────────────────────────────────────────────────────────

describe('parseBlindJudge', () => {
  test('parses a clean JSON verdict', () => {
    const verdict = parseBlindJudge(
      '{"prefer":"B","per_note":[{"note":"开头声明文件名","pick":"B"}],"reasoning":"B 更规范"}',
    );
    expect(verdict).toEqual({
      prefer: 'B',
      perNote: [{ note: '开头声明文件名', pick: 'B' }],
      reasoning: 'B 更规范',
    });
  });

  test('tolerates markdown fences and surrounding chatter', () => {
    const verdict = parseBlindJudge(
      '好的，以下是判断：\n```json\n{"prefer":"tie","per_note":[],"reasoning":"两份相当"}\n```\n以上。',
    );
    expect(verdict).toMatchObject({ prefer: 'tie', perNote: [] });
  });

  test('returns null for malformed payloads', () => {
    expect(parseBlindJudge('not json at all')).toBeNull();
    expect(
      parseBlindJudge('{"prefer":"C","per_note":[],"reasoning":"x"}'),
    ).toBeNull();
    expect(
      parseBlindJudge(
        '{"prefer":"A","per_note":[{"note":"n","pick":"X"}],"reasoning":"x"}',
      ),
    ).toBeNull();
    expect(
      parseBlindJudge('{"per_note":[],"reasoning":"no prefer"}'),
    ).toBeNull();
  });
});

// ── swapLabels ──────────────────────────────────────────────────────────────

describe('swapLabels', () => {
  test('swaps A↔B everywhere, tie stays tie', () => {
    const verdict: BlindJudgeVerdict = {
      prefer: 'A',
      perNote: [
        { note: 'n1', pick: 'A' },
        { note: 'n2', pick: 'B' },
        { note: 'n3', pick: 'tie' },
      ],
      reasoning: 'r',
    };
    expect(swapLabels(verdict)).toEqual({
      prefer: 'B',
      perNote: [
        { note: 'n1', pick: 'B' },
        { note: 'n2', pick: 'A' },
        { note: 'n3', pick: 'tie' },
      ],
      reasoning: 'r',
    });
    expect(swapLabels({ prefer: 'tie', perNote: [], reasoning: '' })).toEqual({
      prefer: 'tie',
      perNote: [],
      reasoning: '',
    });
  });
});

// ── resolveRound + aggregateVerdict ─────────────────────────────────────────

function judge(
  prefer: 'A' | 'B' | 'tie',
  picks: Array<{ note: string; pick: 'A' | 'B' | 'tie' }>,
): BlindJudgeVerdict {
  return { prefer, perNote: picks, reasoning: 'r' };
}

describe('resolveRound', () => {
  test('both judges agreeing on the proposed arm maps to a proposed note hit', () => {
    const note = '开头声明文件名与记录数';
    const round = resolveRound({
      queryId: 'q1',
      baselineText: '基线',
      proposedText: '提案',
      // direct presentation: A=baseline, B=proposed → both judges prefer B/A
      judgeDirect: judge('B', [{ note, pick: 'B' }]),
      judgeSwapped: judge('A', [{ note, pick: 'A' }]),
      expectNotes: [note],
    });
    expect(round.noteHits).toEqual([{ note, arm: 'proposed' }]);
  });

  test('disagreeing judges mark the note tie (no hit for either arm)', () => {
    const note = '输出条目数';
    const round = resolveRound({
      queryId: 'q1',
      baselineText: '基线',
      proposedText: '提案',
      judgeDirect: judge('A', [{ note, pick: 'A' }]),
      judgeSwapped: judge('A', [{ note, pick: 'A' }]),
      expectNotes: [note],
    });
    expect(round.noteHits).toEqual([{ note, arm: 'tie' }]);
  });

  test('a note the judges never covered counts as tie', () => {
    const round = resolveRound({
      queryId: 'q1',
      baselineText: '基线',
      proposedText: '提案',
      judgeDirect: judge('tie', []),
      judgeSwapped: judge('tie', []),
      expectNotes: ['未被覆盖的要点'],
    });
    expect(round.noteHits).toEqual([{ note: '未被覆盖的要点', arm: 'tie' }]);
  });
});

describe('aggregateVerdict', () => {
  const NOTES = ['要点一'];

  function round(
    queryId: string,
    direct: BlindJudgeVerdict | null,
    swapped: BlindJudgeVerdict | null,
    expectNotes: string[] = NOTES,
  ) {
    return resolveRound({
      queryId,
      baselineText: '基线',
      proposedText: '提案',
      judgeDirect: direct,
      judgeSwapped: swapped,
      expectNotes,
    });
  }

  test('proposed wins rounds and notes without losing note coverage → adopt', () => {
    const result = aggregateVerdict([
      // q1: proposed wins both judges; note hit proposed
      round(
        'q1',
        judge('B', [{ note: '要点一', pick: 'B' }]),
        judge('A', [{ note: '要点一', pick: 'A' }]),
      ),
      // q2: tie
      round('q2', judge('tie', []), judge('tie', []), ['要点二']),
    ]);
    expect(result).toMatchObject({
      verdict: 'adopt',
      roundsWon: 1,
      roundsLost: 0,
      roundsTied: 1,
      notesBaselineHit: 0,
      notesProposedHit: 1,
    });
  });

  test('winning votes but dropping note hits → keep_base (gate ② blocks)', () => {
    const result = aggregateVerdict([
      // q1: both judges prefer the proposed reply overall, yet both also say
      // the baseline better covers the note — votes won, note hit lost.
      round(
        'q1',
        judge('B', [{ note: '要点一', pick: 'A' }]),
        judge('A', [{ note: '要点一', pick: 'B' }]),
      ),
    ]);
    expect(result.verdict).toBe('keep_base');
    expect(result.roundsWon).toBe(1);
    expect(result.notesBaselineHit).toBe(1);
    expect(result.notesProposedHit).toBe(0);
  });

  test('baseline clearly winning rounds → keep_base', () => {
    const result = aggregateVerdict([
      round(
        'q1',
        judge('A', [{ note: '要点一', pick: 'A' }]),
        judge('B', [{ note: '要点一', pick: 'B' }]),
      ),
      round(
        'q2',
        judge('A', [{ note: '要点二', pick: 'A' }]),
        judge('B', [{ note: '要点二', pick: 'B' }]),
        ['要点二'],
      ),
    ]);
    expect(result).toMatchObject({
      verdict: 'keep_base',
      roundsWon: 0,
      roundsLost: 2,
      roundsTied: 0,
      notesBaselineHit: 2,
      notesProposedHit: 0,
    });
  });

  test('equal vote split (incl. all ties) → inconclusive', () => {
    const allTie = aggregateVerdict([
      round('q1', judge('tie', []), judge('tie', [])),
      round('q2', judge('tie', []), judge('tie', []), ['要点二']),
    ]);
    expect(allTie.verdict).toBe('inconclusive');
    const split = aggregateVerdict([
      round('q1', judge('B', []), judge('A', [])),
      round('q2', judge('A', []), judge('B', []), ['要点二']),
    ]);
    expect(split).toMatchObject({
      verdict: 'inconclusive',
      roundsWon: 1,
      roundsLost: 1,
    });
  });

  test('failed judges (null) count as tied rounds with no note hits', () => {
    const result = aggregateVerdict([round('q1', null, null)]);
    expect(result).toMatchObject({
      verdict: 'inconclusive',
      roundsWon: 0,
      roundsLost: 0,
      roundsTied: 1,
      notesBaselineHit: 0,
      notesProposedHit: 0,
    });
  });

  test('empty rounds are inconclusive, never adopt', () => {
    expect(aggregateVerdict([]).verdict).toBe('inconclusive');
  });
});
