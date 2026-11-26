import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const indexSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/index.ts'),
  'utf8',
);

describe('channel account startup compatibility contract', () => {
  test('startup projects legacy configs, then connects only first-class accounts', () => {
    expect(indexSource).not.toMatch(/\bconnectUserIMChannels\b/);

    expect(indexSource).toContain('ensureLegacyDefaultChannelAccount({');
    expect(indexSource).toContain(
      'listEnabledChannelAccounts().map((account) =>',
    );
    expect(indexSource).toContain('reloadChannelAccountById(account.id)');
  });

  test('first successful Feishu account connection starts the shared sync scheduler', () => {
    expect(indexSource).toContain(
      "if (connected && account.provider === 'feishu')",
    );
    expect(indexSource).toContain('ensureFeishuSyncScheduler();');
    expect(indexSource).toContain('imManager.syncAllFeishuGroups(uid)');
    expect(indexSource).toContain('Feishu user group sync failed; continuing');
  });
});
