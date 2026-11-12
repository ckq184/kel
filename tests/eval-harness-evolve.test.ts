import { describe, expect, test } from 'vitest';

import { parseEvolveArgs } from '../scripts/eval-harness-evolve.js';

describe('parseEvolveArgs', () => {
  test('parses workspace, limit, and dry-run', () => {
    expect(
      parseEvolveArgs([
        '--workspace',
        'feishu:1@g.us',
        '--limit',
        '20',
        '--dry-run',
      ]),
    ).toEqual({
      workspace: 'feishu:1@g.us',
      limit: 20,
      dryRun: true,
      cluster: true,
      neighbors: true,
    });
  });

  test('defaults limit to 40 and dry-run to false', () => {
    expect(parseEvolveArgs(['--workspace', 'discord:9'])).toEqual({
      workspace: 'discord:9',
      limit: 40,
      dryRun: false,
      cluster: true,
      neighbors: true,
    });
  });

  test('rejects missing workspace', () => {
    expect(parseEvolveArgs(['--dry-run'])).toBeNull();
    expect(parseEvolveArgs([])).toBeNull();
  });

  test('rejects unknown flags', () => {
    expect(parseEvolveArgs(['--workspace', 'w', '--bogus'])).toBeNull();
  });

  test('clamps limit into 1..200', () => {
    expect(
      parseEvolveArgs(['--workspace', 'w', '--limit', '9999'])?.limit,
    ).toBe(200);
    expect(parseEvolveArgs(['--workspace', 'w', '--limit', 'x'])?.limit).toBe(
      40,
    );
  });

  // ── Phase 3 fallback switches (task AH) ──────────────────────────────────

  test('clustering and neighbor lessons are on by default', () => {
    const options = parseEvolveArgs(['--workspace', 'feishu:9']);
    expect(options?.cluster).toBe(true);
    expect(options?.neighbors).toBe(true);
  });

  test('--no-cluster and --no-neighbors restore the legacy behavior', () => {
    expect(
      parseEvolveArgs(['--workspace', 'w', '--no-cluster', '--no-neighbors']),
    ).toMatchObject({ cluster: false, neighbors: false });
    expect(parseEvolveArgs(['--workspace', 'w', '--no-cluster'])).toMatchObject(
      { cluster: false, neighbors: true },
    );
    expect(
      parseEvolveArgs(['--workspace', 'w', '--no-neighbors']),
    ).toMatchObject({ cluster: true, neighbors: false });
  });
});
