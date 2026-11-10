import fs from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../web/src/api/client', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { api } from '../web/src/api/client';
import {
  useAutoMemoryStore,
  type AutoMemoryItem,
} from '../web/src/stores/auto-memory';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf-8');

describe('auto-memory settings tab registration (task W)', () => {
  test('registers the auto-memory tab in all five settings surfaces', () => {
    const types = read('web/src/components/settings/types.ts');
    const page = read('web/src/pages/SettingsPage.tsx');
    const nav = read('web/src/components/settings/SettingsNav.tsx');

    // 1. SettingsTab union
    expect(types).toMatch(/\|\s*'auto-memory'/);
    // 2. VALID_TABS (login-visible per the 2026-11-10 permission decision)
    const validTabs = page.match(
      /const VALID_TABS:[\s\S]*?=\s*\[([\s\S]*?)\];/,
    )?.[1];
    expect(validTabs).toContain("'auto-memory'");
    // 3. NOT in SYSTEM_TABS — auto memory is workspace data, not system config
    const systemTabs = page.match(
      /const SYSTEM_TABS:[\s\S]*?=\s*\[([\s\S]*?)\];/,
    )?.[1];
    expect(systemTabs).not.toContain("'auto-memory'");
    // 4. section title map
    expect(page).toContain("'auto-memory': '自动记忆'");
    // 5. nav item in the account (login-visible) group with BrainCircuit icon
    expect(nav).toContain("key: 'auto-memory'");
    expect(nav).toContain("label: '自动记忆'");
    expect(nav).toContain('BrainCircuit');
    // render branch mounts the section
    expect(page).toContain('<AutoMemorySection />');
  });

  test('information-architecture assertions stay in sync with the new tab', () => {
    const ia = read('tests/frontend-settings-information-architecture.test.ts');
    expect(ia).toContain('expect(nav).toContain("key: \'auto-memory\'")');
  });
});

describe('auto-memory section three-state degradation', () => {
  test('section renders config guide, unavailable reason, and danger confirms', () => {
    const section = read('web/src/components/settings/AutoMemorySection.tsx');
    // 未配置态：配置引导，不渲染管理区（本机默认即此态，不可白屏）
    expect(section).toContain('data/config/auto-memory.json');
    expect(section).toMatch(/enabled.*false|未配置|not_configured/);
    // 侧车不可用态：展示 reason 并禁用管理操作
    expect(section).toContain('available === false');
    expect(section).toMatch(/reason/);
    // workspace 选择器 + 搜索 + 分页
    expect(section).toContain('/api/workspaces');
    expect(section).toMatch(/搜索|search/i);
    expect(section).toMatch(/上一页|下一页|offset/);
    // 危险操作二次确认
    expect(section).toContain('ConfirmDialog');
    expect(section).toContain('confirmVariant="danger"');
    expect(section).toContain('清空');
    // 全部 /api/auto-memory 调用经 store，Section 不直连
    expect(section).not.toContain('/api/auto-memory');
  });
});

describe('auto-memory store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAutoMemoryStore.setState({
      status: null,
      statusLoading: false,
      items: [],
      listLoading: false,
      error: null,
      actionError: null,
      query: '',
      offset: 0,
      hasMore: false,
    });
  });

  const item = (id: string): AutoMemoryItem => ({
    id,
    memory: `memory ${id}`,
    created_at: '2026-11-10T10:00:00',
    metadata: { sessionId: 's1', turnId: 't1' },
  });

  test('loadStatus fetches global status without a workspace probe', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      enabled: true,
      available: true,
    });

    const status = await useAutoMemoryStore.getState().loadStatus();

    expect(api.get).toHaveBeenCalledWith('/api/auto-memory/status');
    expect(status).toEqual({ enabled: true, available: true });
    expect(useAutoMemoryStore.getState().status).toEqual({
      enabled: true,
      available: true,
    });
  });

  test('loadStatus probes a workspace when given a JID', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      enabled: true,
      available: false,
      reason: 'no python',
    });

    const status = await useAutoMemoryStore.getState().loadStatus('web:ws1');

    expect(api.get).toHaveBeenCalledWith(
      '/api/auto-memory/status?workspaceJid=web%3Aws1',
    );
    expect(status.available).toBe(false);
    expect(useAutoMemoryStore.getState().statusLoading).toBe(false);
  });

  test('loadMemories pages the list endpoint and tracks hasMore', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ items: [item('m1')] });

    await useAutoMemoryStore.getState().loadMemories('web:ws1', {
      offset: 40,
    });

    expect(api.get).toHaveBeenCalledWith(
      '/api/auto-memory/workspaces/web%3Aws1/memories?limit=20&offset=40',
    );
    const state = useAutoMemoryStore.getState();
    expect(state.items).toHaveLength(1);
    expect(state.offset).toBe(40);
    expect(state.hasMore).toBe(false);
    expect(state.error).toBeNull();
  });

  test('loadMemories switches to the search endpoint for a query', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      items: [item('m1'), item('m2')],
    });

    await useAutoMemoryStore
      .getState()
      .loadMemories('web:ws1', { query: 'TypeScript' });

    expect(api.get).toHaveBeenCalledWith(
      '/api/auto-memory/workspaces/web%3Aws1/memories/search?q=TypeScript&limit=20',
    );
    expect(useAutoMemoryStore.getState().query).toBe('TypeScript');
  });

  test('loadMemories failures land in the list error, not a blank screen', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('boom'));

    await useAutoMemoryStore.getState().loadMemories('web:ws1');

    expect(useAutoMemoryStore.getState().error).toContain('boom');
    expect(useAutoMemoryStore.getState().listLoading).toBe(false);
  });

  test('deleteMemory mutates then reloads the current view', async () => {
    vi.mocked(api.delete).mockResolvedValueOnce({ deleted: true });
    vi.mocked(api.get).mockResolvedValueOnce({ items: [] });

    await useAutoMemoryStore.getState().deleteMemory('web:ws1', 'mem-9');

    expect(api.delete).toHaveBeenCalledWith(
      '/api/auto-memory/workspaces/web%3Aws1/memories/mem-9',
    );
    expect(api.get).toHaveBeenCalledWith(
      '/api/auto-memory/workspaces/web%3Aws1/memories?limit=20&offset=0',
    );
    expect(useAutoMemoryStore.getState().items).toEqual([]);
  });

  test('a row-level delete failure sets actionError without clobbering items', async () => {
    useAutoMemoryStore.setState({ items: [item('m1')] });
    vi.mocked(api.delete).mockRejectedValueOnce(new Error('sidecar down'));

    await expect(
      useAutoMemoryStore.getState().deleteMemory('web:ws1', 'mem-9'),
    ).rejects.toThrow('sidecar down');

    const state = useAutoMemoryStore.getState();
    expect(state.actionError).toContain('sidecar down');
    expect(state.items).toHaveLength(1);
    expect(state.error).toBeNull();
  });

  test('deleteAll purges through the destructive endpoint then reloads', async () => {
    vi.mocked(api.delete).mockResolvedValueOnce({ deletedAll: true });
    vi.mocked(api.get).mockResolvedValueOnce({ items: [] });

    await useAutoMemoryStore.getState().deleteAll('web:ws1');

    expect(api.delete).toHaveBeenCalledWith(
      '/api/auto-memory/workspaces/web%3Aws1/memories',
    );
    expect(useAutoMemoryStore.getState().items).toEqual([]);
    expect(useAutoMemoryStore.getState().actionError).toBeNull();
  });
});
