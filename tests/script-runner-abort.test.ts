import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test, vi } from 'vitest';

import { removeTmpDirRecursive } from './helpers/remove-tmp-dir.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'script-runner-abort-'));
const groups = path.join(root, 'groups');
fs.mkdirSync(path.join(groups, 'workspace'), { recursive: true });

vi.mock('../src/config.js', () => ({ GROUPS_DIR: groups }));
vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => ({
    containerTimeout: 30_000,
  }),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

afterAll(() => {
  removeTmpDirRecursive(root);
});

// Windows-skip rationale (task K §3.2 batch 2, user adjudication ②: Windows
// hosts do not run host scripts): script-runner.ts hardcodes shell '/bin/sh',
// so on win32 spawn fails ENOENT and the abort/process-tree semantics under
// test are never reached. The /bin/sh hardcode is archived as a follow-up
// task candidate, not fixed here.
describe.skipIf(process.platform === 'win32')('script run cancellation', () => {
  test('aborts only the selected process and never maps SIGKILL to exit 0', async () => {
    const { runScript } = await import('../src/script-runner.js');
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = runScript('sleep 10', 'workspace', {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort('cancelled'), 30);

    const result = await pending;
    expect(result).toMatchObject({
      aborted: true,
      timedOut: false,
      exitCode: null,
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
