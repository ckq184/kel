import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'ckqclaw-groups-mcp-legacy-route-'),
);

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: root,
    GROUPS_DIR: path.join(root, 'groups'),
    isDockerAvailable: () => false,
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'alice',
      username: 'alice',
      role: 'member',
      permissions: [],
    });
    return next();
  },
}));
vi.mock('../src/web.js', () => ({
  broadcastNewMessage: vi.fn(),
  invalidateAllowedUserCache: vi.fn(),
}));

const groupRoutes = (await import('../src/routes/groups.js')).default;

// ISSUE-07 批次B 项2：PUT/GET /api/groups/:jid/mcp 曾是假成功路由——
// PUT 回显请求值但 db 永远写 'inherit'/null，GET 也永远读不回。已拍板下线：
// 两路由固定返回 410，不再触达数据库。
describe('legacy workspace MCP routes return 410 Gone', () => {
  test('GET /api/groups/:jid/mcp responds 410 with an explanation', async () => {
    const response = await groupRoutes.request('/web:some-group/mcp');
    expect(response.status).toBe(410);
    const body = (await response.json()) as { error?: string };
    expect(typeof body.error).toBe('string');
    // 说明需包含：从未真正持久化（始终 inherit）+ 指向用户级 MCP 配置。
    expect(body.error).toMatch(/never persisted|从未/i);
    expect(body.error).toMatch(/inherit/i);
    expect(body.error).toMatch(/mcp-servers/i);
  });

  test('PUT /api/groups/:jid/mcp responds the same 410 without fake success', async () => {
    const response = await groupRoutes.request('/web:some-group/mcp', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mcp_mode: 'custom', selected_mcps: ['x'] }),
    });
    expect(response.status).toBe(410);
    const body = (await response.json()) as {
      error?: string;
      success?: boolean;
    };
    expect(body.success).toBeUndefined();
    expect(typeof body.error).toBe('string');
    expect(body.error).toMatch(/never persisted|从未/i);
    expect(body.error).toMatch(/inherit/i);
    expect(body.error).toMatch(/mcp-servers/i);
  });

  test('410 is returned for any jid, including ones that do not exist (no DB probe)', async () => {
    const get = await groupRoutes.request('/web:does-not-exist/mcp');
    expect(get.status).toBe(410);
    const put = await groupRoutes.request('/web:does-not-exist/mcp', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mcp_mode: 'inherit' }),
    });
    expect(put.status).toBe(410);
  });
});
