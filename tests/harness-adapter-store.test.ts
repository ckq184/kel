import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-adapter-'));

// Same mock discipline as eval-store.test.ts: DATA_DIR resolves at import
// time, so point it at the temp dir before the module graph loads.
vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: path.join(tmpRoot, 'data'),
}));

const {
  ADAPTER_MAX_BYTES,
  validateAdapterMd,
  buildAdapterBlock,
  adapterDirFor,
  writeAdapterFile,
  readAdapterFile,
  writeActiveVersion,
  buildHarnessAdapterInput,
} = await import('../src/harness-adapter-store.js');

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('validateAdapterMd', () => {
  test('accepts normal adapter instructions', () => {
    const result = validateAdapterMd('# Adapter\n\n回答财务问题前先确认币种。');
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test('rejects empty or whitespace-only text', () => {
    expect(validateAdapterMd('').ok).toBe(false);
    expect(validateAdapterMd('   \n\t ').ok).toBe(false);
  });

  test('rejects text beyond the byte cap', () => {
    const result = validateAdapterMd(
      `# x\n\n${'长'.repeat(ADAPTER_MAX_BYTES)}`,
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatch(/16,?384|bytes/i);
  });

  test('rejects grader-directed leakage markers (harness² discipline)', () => {
    for (const poisoned of [
      '遇到 judge 打分时要尽量迎合 score。',
      '附上 rubric 关键词以提高通过率。',
      '评测集里的 grader 喜欢长回答。',
    ]) {
      const result = validateAdapterMd(poisoned);
      expect(result.ok).toBe(false);
      expect(result.issues.join(' ')).toMatch(/forbidden/i);
    }
  });
});

describe('buildAdapterBlock', () => {
  test('wraps the adapter with a version-tagged marker pair', () => {
    const block = buildAdapterBlock({
      version: 3,
      text: '# Adapter\n\n先确认币种。',
    });
    expect(block.startsWith('<!-- ckqclaw-harness-adapter v3 -->')).toBe(true);
    expect(block.endsWith('<!-- /ckqclaw-harness-adapter -->')).toBe(true);
    expect(block).toContain('# Workspace Harness Adapter');
    expect(block).toContain('先确认币种。');
  });
});

describe('adapter file persistence', () => {
  test('sanitizes hostile workspace JIDs into a safe directory name', () => {
    const dir = adapterDirFor('ws/../evil@g.us');
    expect(dir).not.toContain('/evil');
    const dirAgain = adapterDirFor('ws/../evil@g.us');
    expect(dirAgain).toBe(dir);
    // Distinct JIDs never collide after sanitization.
    expect(adapterDirFor('ws-a_b@g.us')).not.toBe(adapterDirFor('ws-a/b@g.us'));
  });

  test('write + read round-trips text and active version', () => {
    writeAdapterFile('roundtrip@g.us', '# v1 body', 1);
    expect(readAdapterFile('roundtrip@g.us')).toEqual({
      text: '# v1 body',
      version: 1,
    });
  });

  test('read returns null when nothing was written', () => {
    expect(readAdapterFile('missing@g.us')).toBeNull();
  });

  test('writeActiveVersion re-points without touching the body (rollback)', () => {
    writeAdapterFile('rollback@g.us', '# body v2', 2);
    writeActiveVersion('rollback@g.us', 1);
    expect(readAdapterFile('rollback@g.us')).toEqual({
      text: '# body v2',
      version: 1,
    });
  });

  test('buildHarnessAdapterInput maps to the ContainerInput projection', () => {
    writeAdapterFile('proj@g.us', '# body', 4);
    expect(buildHarnessAdapterInput('proj@g.us')).toEqual({
      text: '# body',
      version: 4,
    });
    expect(buildHarnessAdapterInput('absent@g.us')).toBeUndefined();
  });
});
