/**
 * THESIS-24 裁 Bug 报告。
 *
 * 验收锚点：
 * - `/api/bug-report/capabilities|generate|submit` 全部 404；
 * - 后端路由文件、挂载与请求 schema 移除；
 * - `BugReportDialog` 文件与侧栏、"关于"页入口移除；
 * - `docs/API.md`、`CLAUDE.md` 不再列该功能。
 *
 * 本包不动 `sdkQuery`（仍有 `/recall`、对话标题、AI 解析定时任务三个调用方），
 * 也不动 browse；测试不触碰这些范围。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { removeTmpDirRecursive } from './helpers/remove-tmp-dir.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ckqclaw-thesis-24-'));
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

function listSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(absolute));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(absolute);
    }
  }
  return files;
}

describe('bug report HTTP surface is removed', () => {
  test.each([
    ['GET', '/api/bug-report/capabilities'],
    ['POST', '/api/bug-report/generate'],
    ['POST', '/api/bug-report/submit'],
  ])('%s %s returns 404', async (method, route) => {
    const response = await app.request(route, {
      method,
      headers: {
        'x-test-user': 'thesis-24-admin',
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      body: method === 'POST' ? '{}' : undefined,
    });
    expect(response.status).toBe(404);
  });

  test('route module, mount point, request schemas and dedicated tests are gone', () => {
    expect(fs.existsSync(path.join(repoRoot, 'src/routes/bug-report.ts'))).toBe(
      false,
    );

    const webSource = read('src/web.ts');
    expect(webSource).not.toContain("from './routes/bug-report.js'");
    expect(webSource).not.toContain("'/api/bug-report'");

    const schemas = read('src/schemas.ts');
    expect(schemas).not.toContain('BugReport');
    expect(schemas).not.toContain('MAX_SCREENSHOT_BASE64_LENGTH');

    for (const relativePath of [
      'tests/bug-report-sanitize.test.ts',
      'tests/thesis-02-bug-report-capability.test.ts',
    ]) {
      expect(
        fs.existsSync(path.join(repoRoot, relativePath)),
        relativePath,
      ).toBe(false);
    }
  });
});

describe('bug report UI is gone', () => {
  test('dialog component file does not exist', () => {
    expect(
      fs.existsSync(
        path.join(repoRoot, 'web/src/components/common/BugReportDialog.tsx'),
      ),
    ).toBe(false);
  });

  test('sidebar and about page have no entry', () => {
    for (const relativePath of [
      'web/src/components/layout/UnifiedSidebar.tsx',
      'web/src/components/settings/AboutSection.tsx',
    ]) {
      const source = read(relativePath);
      expect(source, relativePath).not.toContain('BugReportDialog');
      expect(source, relativePath).not.toContain('showBugReport');
      expect(source, relativePath).not.toContain('报告问题');
      expect(source, relativePath).not.toMatch(
        /import\s*\{[^}]*\bBug\b[^}]*\}\s*from\s*'lucide-react'/s,
      );
    }
  });

  test('no frontend source references the bug report API', () => {
    const offenders = listSourceFiles(path.join(repoRoot, 'web/src'))
      .filter((file) =>
        fs.readFileSync(file, 'utf8').includes('/api/bug-report'),
      )
      .map((file) => path.relative(repoRoot, file));
    expect(offenders).toEqual([]);
  });
});

describe('documentation no longer advertises the bug report feature', () => {
  test('API.md drops the route and section', () => {
    const api = read('docs/API.md');
    expect(api).not.toContain('/api/bug-report');
    expect(api).not.toContain('问题报告');
  });

  test('CLAUDE.md RECALL_MODEL description drops the bug report caller', () => {
    expect(read('CLAUDE.md')).not.toContain('Bug 报告摘要');
  });
});
