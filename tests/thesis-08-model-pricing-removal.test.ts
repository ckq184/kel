/**
 * THESIS-08 用量（三）：模型单价下线。
 *
 * 验收锚点：
 * - `/api/pricing` 五个接口（含未认证请求）全部 404；
 * - 定价层 6 个源码文件删除，`src/schemas.ts` 不再保留只服务该接口的定价 schema；
 * - 设置导航、设置页与标签类型不再有 `pricing` / "模型单价" 入口；
 * - `docs/API.md`、`docs/ACL-MATRIX.md` 不再列 `/api/pricing`。
 *
 * `custom_model_pricing` 表与 `src/db.ts` 的读写函数不在本包范围（THESIS-14），
 * 测试也不触碰；聊天气泡与飞书摘要同理（THESIS-09）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { removeTmpDirRecursive } from './helpers/remove-tmp-dir.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ckqclaw-thesis-08-'));
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

// 把 authMiddleware 固定为 401（不建立真实登录态）：路由真挂载时返回 401，
// 与"未挂载"的 404 可以区分，PATCH/DELETE 也不会因为 "Rule not found" 假绿。
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  authMiddleware: async (c: any) => c.json({ error: 'Unauthorized' }, 401),
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
const exists = (relativePath: string) =>
  fs.existsSync(path.join(repoRoot, relativePath));

describe('pricing HTTP surface is removed', () => {
  test.each([
    ['GET', '/api/pricing/rules'],
    ['POST', '/api/pricing/rules'],
    ['PATCH', '/api/pricing/rules/cmp_missing'],
    ['DELETE', '/api/pricing/rules/cmp_missing'],
    ['POST', '/api/pricing/preview'],
  ])('%s %s returns 404 without auth', async (method, route) => {
    const response = await app.request(route, { method });
    expect(response.status).toBe(404);
  });

  // 正控制：证明 app 装配与 authMiddleware mock 仍然生效，避免整表路由失效时
  // 五条 404 断言假绿。
  test('a known protected route still returns 401', async () => {
    const response = await app.request('/api/config/system');
    expect(response.status).toBe(401);
  });

  test('route module and mount point are gone', () => {
    expect(exists('src/routes/pricing.ts')).toBe(false);
    const webSource = read('src/web.ts');
    expect(webSource).not.toMatch(/['"`]\.\/routes\/pricing\.js['"`]/);
    expect(webSource).not.toMatch(/['"`]\/api\/pricing['"`]/);
    expect(exists('src/kaboo-pricing.ts')).toBe(false);
    expect(exists('src/custom-pricing-store.ts')).toBe(false);
  });

  test('pricing-only zod schemas are gone', () => {
    const schemas = read('src/schemas.ts');
    expect(schemas).not.toContain('CustomPricingCreateSchema');
    expect(schemas).not.toContain('CustomPricingPatchSchema');
    expect(schemas).not.toContain('CustomPricingPreviewSchema');
    expect(schemas).not.toContain('customPricingFields');
    expect(schemas).not.toContain('pricePerMTok');
    expect(schemas).not.toContain('Custom model pricing schemas');
  });
});

describe('pricing settings surface is gone', () => {
  test.each([
    'web/src/components/settings/ModelPricingSection.tsx',
    'web/src/components/settings/ModelPricingDialog.tsx',
    'web/src/stores/model-pricing.ts',
  ])('%s does not exist', (relativePath) => {
    expect(exists(relativePath)).toBe(false);
  });

  test('settings nav, tab type and page have no pricing entry', () => {
    const nav = read('web/src/components/settings/SettingsNav.tsx');
    expect(nav).not.toMatch(/['"`]pricing['"`]/);
    expect(nav).not.toContain('模型单价');
    expect(nav).not.toMatch(/\bCoins\b/);

    const types = read('web/src/components/settings/types.ts');
    expect(types).not.toMatch(/['"`]pricing['"`]/);

    const page = read('web/src/pages/SettingsPage.tsx');
    expect(page).not.toContain('ModelPricingSection');
    expect(page).not.toMatch(/['"`]pricing['"`]/);
    expect(page).not.toContain('模型单价');
  });

  test('no reminder of the removed pricing modules in the runner comments', () => {
    const session = read('container/agent-runner/src/runtime/pi/pi-session.ts');
    expect(session).not.toContain('kaboo-pricing');
    expect(session).not.toContain('usage-service');
  });
});

describe('superseded pricing tests are gone', () => {
  test.each([
    'tests/pricing-routes.test.ts',
    'tests/custom-pricing.test.ts',
    'tests/custom-pricing-frontend.test.ts',
    'tests/kaboo-pricing.test.ts',
  ])('%s is deleted', (relativePath) => {
    expect(exists(relativePath)).toBe(false);
  });
});

describe('documentation no longer advertises model pricing', () => {
  test('API and ACL matrix drop the pricing surface', () => {
    const api = read('docs/API.md');
    expect(api).not.toContain('/api/pricing');
    expect(api).not.toContain('## 模型单价');

    const acl = read('docs/ACL-MATRIX.md');
    expect(acl).not.toContain('/api/pricing');
    expect(acl).not.toContain('模型单价');
  });
});
