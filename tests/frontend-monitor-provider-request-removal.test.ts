import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('monitor provider request removal', () => {
  test('MonitorPage no longer fetches providers that ProviderSwitcher discards', () => {
    const page = read('web/src/pages/MonitorPage.tsx');

    // 该 GET 的返回值被 ProviderSwitcher 丢弃，却会触发后端
    // providerPool.refreshFromConfig 副作用（src/routes/config.ts）。
    expect(page).not.toContain('claude/providers');
    expect(page).not.toContain('providers');
    expect(page).not.toContain('SimpleProvider');
    // 监控主体逻辑保留
    expect(page).toContain('loadStatus');
    expect(page).toContain('ProviderSwitcher');
  });

  test('ProviderSwitcher and GroupStatusCard drop the unused providers prop chain', () => {
    const switcher = read('web/src/components/monitor/ProviderSwitcher.tsx');
    const card = read('web/src/components/monitor/GroupStatusCard.tsx');

    expect(switcher).not.toContain('providers');
    expect(switcher).not.toContain('SimpleProvider');
    expect(card).not.toContain('providers');
    // 当前 provider 展示保留
    expect(switcher).toContain('currentProviderName');
  });
});
