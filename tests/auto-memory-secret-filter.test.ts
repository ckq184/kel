/**
 * Task F2: secret-filter receipt surfacing + python self-test bridge.
 *
 * The sidecar redacts credential-like values before mem0 stores anything
 * (task F1, container/agent-runner/python/auto_memory_sidecar.py). This
 * file pins the TS-facing contracts:
 *  1. summarizeAutoMemoryAddResult must surface the `intercepted` findings
 *     so the model can tell the user the plaintext was NOT stored — and
 *     must not fall back to the misleading "judged a duplicate" wording
 *     when content was intercepted but extracted nothing.
 *  2. `py -3 auto_memory_sidecar.py --self-test` (the F1 red/green table)
 *     must pass wherever the sidecar itself can run; hosts without python
 *     skip with a note instead of failing.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { summarizeAutoMemoryAddResult } from '../container/agent-runner/src/mcp-tools.js';

const SIDECAR_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'container',
  'agent-runner',
  'python',
  'auto_memory_sidecar.py',
);

describe('summarizeAutoMemoryAddResult — intercepted secret findings', () => {
  test('appends the redaction line after captured facts', () => {
    const summary = summarizeAutoMemoryAddResult({
      results: [
        {
          id: 'm1',
          memory: 'User 提供了店铺后台密码（内容未存储）',
          event: 'ADD',
        },
      ],
      intercepted: [{ pattern: 'keyword_value', count: 1 }],
    });
    expect(summary).toContain('[ADD] User 提供了店铺后台密码');
    expect(summary).toContain('1 credential-like value(s) redacted');
    expect(summary).toContain('plaintext not stored');
  });

  test('sums counts across patterns', () => {
    const summary = summarizeAutoMemoryAddResult({
      results: [],
      intercepted: [
        { pattern: 'keyword_value', count: 2 },
        { pattern: 'openai_sk', count: 1 },
      ],
    });
    expect(summary).toContain('3 credential-like value(s) redacted');
  });

  test('empty results with interception avoid the duplicate wording', () => {
    const summary = summarizeAutoMemoryAddResult({
      results: [],
      intercepted: [{ pattern: 'bearer', count: 1 }],
    });
    expect(summary).not.toContain('duplicate');
    expect(summary).toContain('redacted');
  });
});

describe('summarizeAutoMemoryAddResult — base shapes (previously untested)', () => {
  test('array result lists ADD facts', () => {
    const summary = summarizeAutoMemoryAddResult([
      { id: 'a', memory: 'likes tea', event: 'ADD' },
    ]);
    expect(summary).toContain('Captured 1 fact(s)');
    expect(summary).toContain('[ADD] likes tea');
  });

  test('empty results keep the duplicate explanation', () => {
    const summary = summarizeAutoMemoryAddResult({ results: [] });
    expect(summary).toContain('judged a duplicate');
  });

  test('unknown shape keeps the legacy Captured line', () => {
    expect(summarizeAutoMemoryAddResult('ok')).toBe(
      'Captured into automatic memory.',
    );
  });
});

describe('sidecar secret-filter self-test (task F1 table)', () => {
  test('py -3 auto_memory_sidecar.py --self-test exits 0', () => {
    const isWindows = process.platform === 'win32';
    const command = isWindows ? 'py' : 'python3';
    const args = [...(isWindows ? ['-3'] : []), SIDECAR_SCRIPT, '--self-test'];
    const run = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (run.error) {
      // No python on this host — the sidecar reports unavailable at runtime
      // the same way; keep the gap visible instead of failing the suite.
      console.warn(`skipped: ${command} unavailable (${run.error.code})`);
      return;
    }
    if (run.status !== 0) {
      throw new Error(
        `sidecar self-test exited ${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
      );
    }
  });
});
