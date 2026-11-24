/**
 * THESIS-06 用量（一）：用量分析页与 `/api/usage` 下线。
 *
 * 验收锚点：
 * - `/api/usage` 六个只读接口全部 404；
 * - 页面层文件、导航与聊天页入口、设置页旧地址、登录态 store 重置均无残留；
 * - `recharts` 从 web 依赖移除；
 * - `docs/API.md`、`docs/ACL-MATRIX.md`、`CLAUDE.md` 不再列 `/api/usage`、`/usage`。
 *
 * 记账、`usage` 流事件与聊天气泡不在本包范围，测试也不触碰。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { removeTmpDirRecursive } from './helpers/remove-tmp-dir.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ckqclaw-thesis-06-'));
const dataDir = path.join(tmp, 'data');
const storeDir = path.join(dataDir, 'db');
const groupsDir = path.join(dataDir, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: dataDir,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  authMiddleware: async (c: any, next: any) => {
    const userId = c.req.header('x-test-user');
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', {
      id: userId,
      username: userId,
      display_name: userId,
      role: 'admin',
      status: 'active',
      permissions: [],
      must_change_password: false,
    });
    return next();
  },
}));

const db = await import('../src/db.js');
const web = await import('../src/web.js');

const app = web.createAppForTest({
  queue: {
    stopGroup: vi.fn(async () => {}),
    listDescendantJids: () => [],
    pauseGroupsForMutation: () => ({ id: 0 }),
    resumeGroupsAfterMutation: vi.fn(),
  },
  getRegisteredGroups: () => ({}),
  sessions: {},
} as any);

beforeAll(() => {
  db.initDatabase();
});

afterAll(() => {
  removeTmpDirRecursive(tmp, [db.closeDatabase]);
});

const repoRoot = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

describe('usage HTTP surface is removed', () => {
  test.each([
    '/api/usage/stats',
    '/api/usage/models',
    '/api/usage/filters',
    '/api/usage/records',
    '/api/usage/export.csv',
    '/api/usage/users',
  ])('GET %s returns 404', async (route) => {
    const response = await app.request(route, {
      headers: { 'x-test-user': 'thesis-06-admin' },
    });
    expect(response.status).toBe(404);
  });

  test('route module and mount point are gone', () => {
    expect(fs.existsSync(path.join(repoRoot, 'src/routes/usage.ts'))).toBe(
      false,
    );
    const webSource = read('src/web.ts');
    expect(webSource).not.toContain("from './routes/usage.js'");
    expect(webSource).not.toContain("'/api/usage'");
  });
});

describe('usage page layer is gone', () => {
  test.each([
    'web/src/pages/UsagePage.tsx',
    'web/src/stores/usage.ts',
    'web/src/components/usage/UsageTrendChart.tsx',
    'web/src/components/usage/format.ts',
    'web/src/utils/usage-format.ts',
  ])('%s does not exist', (relativePath) => {
    expect(fs.existsSync(path.join(repoRoot, relativePath))).toBe(false);
  });

  test('App, navigation, chat menu, settings and auth store have no entry', () => {
    const appSource = read('web/src/App.tsx');
    expect(appSource).not.toMatch(/\/usage|UsagePage|UsageRouteFallback/);

    const navItems = read('web/src/components/layout/nav-items.ts');
    expect(navItems).not.toMatch(/\/usage|BarChart3|hideOnMobile/);

    const bottomTabBar = read('web/src/components/layout/BottomTabBar.tsx');
    expect(bottomTabBar).not.toContain('hideOnMobile');

    const settingsNav = read('web/src/components/settings/SettingsNav.tsx');
    expect(settingsNav).not.toContain("'usage'");

    const chatPage = read('web/src/pages/ChatPage.tsx');
    expect(chatPage).not.toMatch(/\/usage|用量统计|BarChart3/);

    const settings = read('web/src/pages/SettingsPage.tsx');
    expect(settings).not.toContain("'usage'");
    expect(settings).not.toContain("usage: '/usage'");

    const settingsTypes = read('web/src/components/settings/types.ts');
    expect(settingsTypes).not.toContain("'usage'");

    const authStore = read('web/src/stores/auth.ts');
    expect(authStore).not.toContain('useUsageStore');
    expect(authStore).not.toContain("from './usage'");

    // §11.4 第 2 项：只服务用量页导出兜底的下载辅助不再保留。
    const download = read('web/src/utils/download.ts');
    expect(download).not.toContain('downloadTextFile');
    expect(download).not.toMatch(
      /export\s+(\{[^}]*DownloadError|class\s+DownloadError)/,
    );
  });

  test('recharts is no longer a web dependency', () => {
    const pkg = JSON.parse(read('web/package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.recharts).toBeUndefined();
    expect(pkg.devDependencies?.recharts).toBeUndefined();
    expect(read('web/package-lock.json')).not.toContain(
      'node_modules/recharts',
    );
  });
});

describe('documentation no longer advertises the usage surface', () => {
  test('API, ACL matrix and CLAUDE.md drop usage rows', () => {
    expect(read('docs/API.md')).not.toContain('/api/usage');
    expect(read('docs/ACL-MATRIX.md')).not.toContain('/api/usage');

    const claude = read('CLAUDE.md');
    expect(claude).not.toMatch(/\|\s*`\/usage`\s*\|/);
    expect(claude).not.toContain('`usage`→`/usage`');
  });
});
