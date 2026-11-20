import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('paired chat rename removal', () => {
  test('usePairedChats no longer issues the unsupported PUT rename request', () => {
    const hook = read('web/src/components/settings/hooks/usePairedChats.ts');

    // 后端只有 GET/DELETE；rename 发出的 PUT 必 404，经用户拍板连消费端一起下线。
    expect(hook).not.toContain('rename');
    expect(hook).not.toContain('renamingJid');
    expect(hook).not.toContain('api.put');

    // 加载与解除配对保留
    expect(hook).toContain('api.get');
    expect(hook).toContain('api.delete');
  });

  test('PairingSection drops the rename plumbing from its paired prop contract', () => {
    const section = read('web/src/components/settings/PairingSection.tsx');

    expect(section).not.toContain('rename');
    expect(section).not.toContain('renamingJid');
    expect(section).toContain('paired.remove(chat.jid)');
  });

  test('the wechat pairing dialog mock no longer fabricates a rename API', () => {
    const dom = read('tests/wechat-pairing-dialog-dom.test.tsx');

    expect(dom).not.toContain('rename');
  });
});
