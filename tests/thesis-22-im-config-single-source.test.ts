import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();

function sourceFiles(dir: string): string[] {
  return fs
    .readdirSync(path.join(root, dir), { withFileTypes: true })
    .flatMap((entry) => {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(relative);
      return entry.name.endsWith('.ts') ? [relative] : [];
    });
}

const srcSource = sourceFiles('src')
  .map((file) => fs.readFileSync(path.join(root, file), 'utf8'))
  .join('\n');

function indexSlice(startMarker: string, endMarker: string): string {
  const source = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8');
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('THESIS-22 IM config single source', () => {
  test('legacy per-user and global IM config storage does not appear in src', () => {
    const legacySymbols = [
      'getUserFeishuConfig',
      'saveUserFeishuConfig',
      'saveFeishuOwnerOpenId',
      'getUserQQConfig',
      'saveUserQQConfig',
      'getUserWeChatConfig',
      'saveUserWeChatConfig',
      'ensureLegacyDefaultChannelAccount',
      'syncDefaultChannelAccountCredentials',
      'getFeishuProviderConfigWithSource',
      'migrateSystemIMToPerUser',
      'syncLegacyConfigToDefaultChannelAccount',
      'migrateDataDirectories',
      'movePathWithFallback',
      'autoIsolateContext',
      'USER_IM_CONFIG_DIR',
      'feishu-provider.json',
      'FeishuConfigSchema',
    ];
    for (const symbol of legacySymbols) {
      expect(srcSource, symbol).not.toContain(symbol);
    }
  });

  test('legacy channel-account migration module is deleted', () => {
    expect(
      fs.existsSync(path.join(root, 'src/channel-account-migration.ts')),
    ).toBe(false);
  });

  test('channel account routes no longer project or mirror legacy config files', () => {
    const source = fs.readFileSync(
      path.join(root, 'src/routes/channel-accounts.ts'),
      'utf8',
    );
    expect(source).not.toContain("from '../runtime-config.js'");
    expect(source).not.toContain('syncLegacyUserImFacade');
    expect(source).not.toContain('legacyCredentialsFor');
    expect(source).not.toContain('ensureLegacyDefaultChannelAccounts');
  });

  test('setupStatus derives feishuConfigured from channel accounts', () => {
    const source = fs.readFileSync(
      path.join(root, 'src/routes/auth.ts'),
      'utf8',
    );
    const start = source.indexOf('function buildSetupStatus()');
    const end = source.indexOf('// --- Routes ---', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const setup = source.slice(start, end);
    expect(setup).not.toContain('getFeishuProviderConfigWithSource');
    expect(setup).toContain('listEnabledChannelAccounts()');
    expect(setup).toMatch(/provider === 'feishu'/);
  });

  test('/allow owner backfill reads ownerOpenId from the channel account secret', () => {
    const allow = indexSlice(
      'function resolveFeishuOwnerOpenIdForGroup(',
      'function handleDisallowCommand(',
    );
    expect(allow).toContain('loadChannelAccountSecret(');
    expect(allow).not.toContain('getUserFeishuConfig');
  });

  test('unknown Feishu admission reads ownerOpenId from the channel account secret', () => {
    const admission = indexSlice(
      'function isSenderAllowedInGroup(',
      'function handleIncomingFollowUp(',
    );
    expect(admission).toContain('loadChannelAccountSecret(');
    expect(admission).not.toContain('getUserFeishuConfig');
  });

  test('autoIsolateContext bulk binding symbols are gone', () => {
    expect(srcSource).not.toContain('applyAutoIsolateContextForGroups');
    expect(srcSource).not.toContain('getUserContextIsolationConfig');
    expect(srcSource).not.toContain('applyAutoIsolateContext');
    expect(srcSource).not.toContain('ensureAutoImConversationBinding');
  });
});
