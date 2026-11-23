/**
 * ISSUE-21 防回潮契约：各 issue 交付记录登记的零散遗留落地后的源码约束。
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');
const read = (rel: string) =>
  fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');

describe('ISSUE-21 A3: npm scripts and CI only run files that exist', () => {
  const pkg = JSON.parse(read('package.json')) as {
    scripts: Record<string, string>;
  };

  test('no npm script points at a missing scripts/ file', () => {
    const missing: string[] = [];
    for (const [name, command] of Object.entries(pkg.scripts)) {
      for (const match of command.matchAll(
        /scripts\/[\w./-]+\.(?:ts|mjs|sh)/g,
      )) {
        if (!fs.existsSync(path.join(repoRoot, match[0]))) {
          missing.push(`${name} -> ${match[0]}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test('every `npm run <name>` in CI names a defined root script', () => {
    const ci = read('.github/workflows/ci.yml');
    const undefinedScripts = [...ci.matchAll(/run: npm run ([\w:-]+)/g)]
      .map((m) => m[1])
      .filter((name) => !(name in pkg.scripts));
    expect(undefinedScripts).toEqual([]);
  });

  test('the stale background-task self-test is gone', () => {
    expect(
      fs.existsSync(path.join(repoRoot, 'scripts/self-test-agent-runner.ts')),
    ).toBe(false);
    expect(pkg.scripts['self-test:agent-runner']).toBeUndefined();
    expect(pkg.scripts['self-test']).toBe(
      'npm run build:all && npm test -- --run',
    );
  });
});

describe('ISSUE-21 A4: auto-created IM conversation log is channel-neutral', () => {
  test('the /new log line no longer claims every chat is Feishu', () => {
    const index = read('src/index.ts');
    expect(index).not.toContain('for Feishu IM chat');
    expect(index).toMatch(
      /channel: getChannelType\(input\.sourceJid\)[\s\S]{0,200}'Auto-created isolated conversation agent for IM chat'/,
    );
  });
});
