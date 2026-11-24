import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('frontend load error visibility', () => {
  test('MonitorPage surfaces the monitor store load error', () => {
    const page = read('web/src/pages/MonitorPage.tsx');

    // loadStatus 失败时 status 可能为 null、loading 为 false——没有横幅就是白屏。
    expect(page).toMatch(
      /const \{[\s\S]*?\berror\b,[\s\S]*?\} = useMonitorStore\(\)/,
    );
    expect(page).toContain('role="alert"');
    expect(page).toContain('{error &&');
  });

  test('FilePanel surfaces the files store error', () => {
    const panel = read('web/src/components/chat/FilePanel.tsx');

    expect(panel).toMatch(
      /const \{[\s\S]*?\berror\b,[\s\S]*?\} = useFileStore\(\)/,
    );
    expect(panel).toContain('role="alert"');
    expect(panel).toContain('{error &&');
  });
});
