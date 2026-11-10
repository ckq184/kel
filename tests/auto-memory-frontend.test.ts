import fs from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../web/src/api/client', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
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

describe('auto-memory endpoint card states (task X)', () => {
  test('card renders the three config states with masked prefill', () => {
    const card = read('web/src/components/settings/AutoMemoryEndpointCard.tsx');

    // env 覆盖态：只读提示 + 表单禁用（CKQCLAW_AUTO_MEMORY 通道优先）
    expect(card).toContain("source === 'env'");
    expect(card).toContain('CKQCLAW_AUTO_MEMORY');
    // 文件态：掩码预填（apiKeyMasked → apiKey 输入框）
    expect(card).toContain('apiKeyMasked');
    // 保留语义提示：留空/掩码不动 = 保留现有密钥
    expect(card).toMatch(/留空|保留现有密钥|掩码/);
    // 保存成功文案明示侧车促生效语义
    expect(card).toContain('已停止全部自动记忆侧车');
    // 清除走 danger 二次确认
    expect(card).toContain('ConfirmDialog');
    expect(card).toContain('confirmVariant="danger"');
  });

  test('card calls the config API only through the store', () => {
    const card = read('web/src/components/settings/AutoMemoryEndpointCard.tsx');
    expect(card).toContain('useAutoMemoryStore');
    expect(card).not.toContain('/api/auto-memory');
  });

  test('section unconfigured state gates the jump by manage_system_config', () => {
    const section = read('web/src/components/settings/AutoMemorySection.tsx');
    // 有权用户：「去配置」跳模型配置 tab
    expect(section).toContain('canManageSystemConfig');
    expect(section).toContain('/settings?tab=claude');
    expect(section).toContain('去配置');
    // 普通用户：保留文件引导文案
    expect(section).toContain('data/config/auto-memory.json');
  });
});

describe('auto-memory config store actions (task X)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAutoMemoryStore.setState({
      config: null,
      configLoading: false,
      configError: null,
      actionError: null,
    });
  });

  const FILE_CONFIG = {
    source: 'file',
    enabled: true,
    llm: {
      baseUrl: 'https://llm.test/v1',
      model: 'gpt-m',
      apiKeyMasked: 'sk-l***3456',
    },
    embedder: {
      baseUrl: 'https://embed.test/v1',
      model: 'embed-m',
      apiKeyMasked: 'sk-e***3456',
    },
  };

  test('loadConfig fetches the masked view into state', async () => {
    vi.mocked(api.get).mockResolvedValueOnce(FILE_CONFIG);

    const config = await useAutoMemoryStore.getState().loadConfig();

    expect(api.get).toHaveBeenCalledWith('/api/auto-memory/config');
    expect(config?.source).toBe('file');
    expect(useAutoMemoryStore.getState().config?.llm?.apiKeyMasked).toBe(
      'sk-l***3456',
    );
    expect(useAutoMemoryStore.getState().configLoading).toBe(false);
  });

  test('loadConfig failures land in configError, not a blank screen', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('Forbidden'));

    const config = await useAutoMemoryStore.getState().loadConfig();

    expect(config).toBeNull();
    const state = useAutoMemoryStore.getState();
    expect(state.configError).toContain('Forbidden');
    expect(state.configLoading).toBe(false);
  });

  test('saveConfig PUTs the pair (blank keys keep old) then reloads', async () => {
    vi.mocked(api.put).mockResolvedValueOnce({
      ok: true,
      sidecarsRestarted: true,
    });
    vi.mocked(api.get).mockResolvedValueOnce(FILE_CONFIG);

    await useAutoMemoryStore.getState().saveConfig({
      llm: { baseUrl: 'https://llm.test/v1', apiKey: '', model: 'gpt-m' },
      embedder: {
        baseUrl: 'https://embed.test/v1',
        apiKey: 'sk-e***3456',
        model: 'embed-m',
      },
    });

    expect(api.put).toHaveBeenCalledWith('/api/auto-memory/config', {
      llm: { baseUrl: 'https://llm.test/v1', apiKey: '', model: 'gpt-m' },
      embedder: {
        baseUrl: 'https://embed.test/v1',
        apiKey: 'sk-e***3456',
        model: 'embed-m',
      },
    });
    expect(api.get).toHaveBeenCalledWith('/api/auto-memory/config');
    expect(useAutoMemoryStore.getState().config?.source).toBe('file');
  });

  test('saveConfig failures set actionError and rethrow', async () => {
    vi.mocked(api.put).mockRejectedValueOnce(new Error('env_override'));

    await expect(
      useAutoMemoryStore.getState().saveConfig({
        llm: { baseUrl: 'https://x', apiKey: 'k', model: 'm' },
        embedder: { baseUrl: 'https://y', apiKey: 'k', model: 'e' },
      }),
    ).rejects.toThrow('env_override');

    expect(useAutoMemoryStore.getState().actionError).toContain('env_override');
  });

  test('clearConfig DELETEs then reloads the none state', async () => {
    vi.mocked(api.delete).mockResolvedValueOnce({
      ok: true,
      sidecarsRestarted: true,
    });
    vi.mocked(api.get).mockResolvedValueOnce({
      source: 'none',
      enabled: false,
    });

    await useAutoMemoryStore.getState().clearConfig();

    expect(api.delete).toHaveBeenCalledWith('/api/auto-memory/config');
    expect(useAutoMemoryStore.getState().config?.source).toBe('none');
    expect(useAutoMemoryStore.getState().actionError).toBeNull();
  });
});

describe('chat capture store actions (task Y/Y2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAutoMemoryStore.setState({ actionError: null });
  });

  test('previewCapture GETs with repeated agentId params (multi-session)', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ messages: 12, chars: 3400 });

    const preview = await useAutoMemoryStore
      .getState()
      .previewCapture('web:ws1', ['', 'agent-7']);

    expect(api.get).toHaveBeenCalledWith(
      '/api/auto-memory/workspaces/web%3Aws1/capture/preview?agentId=&agentId=agent-7',
    );
    expect(preview).toEqual({ messages: 12, chars: 3400 });
  });

  test('previewCapture with an empty selection targets the main conversation', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ messages: 3, chars: 90 });

    await useAutoMemoryStore.getState().previewCapture('web:ws1', []);

    expect(api.get).toHaveBeenCalledWith(
      '/api/auto-memory/workspaces/web%3Aws1/capture/preview',
    );
  });

  test('previewCapture failures set actionError and rethrow', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('not_configured'));

    await expect(
      useAutoMemoryStore.getState().previewCapture('web:ws1', ['']),
    ).rejects.toThrow('not_configured');
    expect(useAutoMemoryStore.getState().actionError).toContain(
      'not_configured',
    );
  });

  test('captureConversation POSTs agentIds with the 90s extraction timeout', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({
      ok: true,
      captured: 12,
      added: 5,
      intercepted: 1,
    });

    const receipt = await useAutoMemoryStore
      .getState()
      .captureConversation('web:ws1', ['', 'agent-7']);

    // 60k 字一次 LLM 提炼可能 10-60s——默认 8s 会误杀，钉住 90s。
    expect(api.post).toHaveBeenCalledWith(
      '/api/auto-memory/workspaces/web%3Aws1/capture',
      { agentIds: ['', 'agent-7'] },
      90_000,
    );
    expect(receipt).toMatchObject({ ok: true, captured: 12, added: 5 });
  });

  test('captureConversation main-only posts an explicit empty-string marker', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({
      ok: true,
      captured: 1,
      added: 1,
      intercepted: 0,
    });

    await useAutoMemoryStore.getState().captureConversation('web:ws1', ['']);

    expect(api.post).toHaveBeenCalledWith(
      '/api/auto-memory/workspaces/web%3Aws1/capture',
      { agentIds: [''] },
      90_000,
    );
  });

  test('captureConversation failures set actionError and rethrow', async () => {
    vi.mocked(api.post).mockRejectedValueOnce(new Error('Request timeout'));

    await expect(
      useAutoMemoryStore.getState().captureConversation('web:ws1', ['']),
    ).rejects.toThrow('Request timeout');
    expect(useAutoMemoryStore.getState().actionError).toContain(
      'Request timeout',
    );
  });
});

describe('chat capture button (task Y2)', () => {
  test('ChatView opens the multi-session capture dialog behind the gated button', () => {
    const view = read('web/src/components/chat/ChatView.tsx');

    // Header button on the workspace-config template: icon + label + gate.
    expect(view).toContain('BrainCircuit');
    expect(view).toContain('提炼记忆');
    expect(view).toMatch(/canModifyWorkspaceConfig && \(/);
    // The inline single-session confirm flow is gone; the dialog owns it.
    expect(view).toContain('<CaptureMemoryDialog');
    expect(view).not.toContain('capturePreview');
    // All /api/auto-memory calls go through the store, never direct.
    expect(view).not.toContain('/api/auto-memory');
  });

  test('CaptureMemoryDialog selects sessions, previews merged cost, confirms', () => {
    const dialog = read('web/src/components/chat/CaptureMemoryDialog.tsx');

    // Checkbox list with the current session preselected.
    expect(dialog).toMatch(/Checkbox/);
    expect(dialog).toContain('defaultSelected');
    // Debounced re-preview so checkbox churn does not spam requests.
    expect(dialog).toMatch(/300/);
    // Merged-budget wording + cost + timeout hints (user decisions).
    expect(dialog).toMatch(/合并后最新/);
    expect(dialog).toMatch(/一次模型调用/);
    expect(dialog).toMatch(/超时/);
    // Receipt toast: captured/added counts + redaction note; busy guard.
    expect(dialog).toMatch(/提炼完成/);
    expect(dialog).toMatch(/已脱敏/);
    expect(dialog).toMatch(/busy/);
    // Both store actions used, never a direct API call.
    expect(dialog).toContain('previewCapture');
    expect(dialog).toContain('captureConversation');
    expect(dialog).not.toContain('/api/auto-memory');
  });
});

describe('message-pick capture store action (task Y3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAutoMemoryStore.setState({ actionError: null });
  });

  test('captureMessages POSTs messageIds with the 90s extraction timeout', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({
      ok: true,
      captured: 4,
      added: 3,
      intercepted: 0,
    });

    const receipt = await useAutoMemoryStore
      .getState()
      .captureMessages('web:ws1', 'agent-7', ['m1', 'm2', 'm3', 'm4']);

    expect(api.post).toHaveBeenCalledWith(
      '/api/auto-memory/workspaces/web%3Aws1/capture',
      { agentId: 'agent-7', messageIds: ['m1', 'm2', 'm3', 'm4'] },
      90_000,
    );
    expect(receipt).toMatchObject({ ok: true, captured: 4, added: 3 });
  });

  test('captureMessages omits agentId for the main conversation', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({
      ok: true,
      captured: 1,
      added: 1,
      intercepted: 0,
    });

    await useAutoMemoryStore.getState().captureMessages('web:ws1', '', ['m1']);

    expect(api.post).toHaveBeenCalledWith(
      '/api/auto-memory/workspaces/web%3Aws1/capture',
      { messageIds: ['m1'] },
      90_000,
    );
  });

  test('captureMessages failures set actionError and rethrow', async () => {
    vi.mocked(api.post).mockRejectedValueOnce(
      new Error('selected messages total 62,000 chars'),
    );

    await expect(
      useAutoMemoryStore.getState().captureMessages('web:ws1', '', ['m1']),
    ).rejects.toThrow('62,000');
    expect(useAutoMemoryStore.getState().actionError).toContain('62,000');
  });
});

describe('message-pick capture UI (task Y3)', () => {
  test('dialog offers a message-pick mode backed by the picker component', () => {
    const dialog = read('web/src/components/chat/CaptureMemoryDialog.tsx');

    // Mode switch between session-merge (Y2) and message-pick (Y3).
    expect(dialog).toMatch(/按会话/);
    expect(dialog).toMatch(/按消息/);
    expect(dialog).toContain('messagePicker');
    expect(dialog).toContain('<CaptureMessagePicker');
    // Message mode uses the exact-mode store action with a local budget
    // guard (refuse-not-trim, mirrored from the server's 60k check).
    expect(dialog).toContain('captureMessages');
    expect(dialog).toMatch(/60_000/);
    expect(dialog).toMatch(/超过/);
    expect(dialog).not.toContain('/api/auto-memory');
  });

  test('CaptureMessagePicker lists, checks, and paginates messages', () => {
    const picker = read('web/src/components/chat/CaptureMessagePicker.tsx');

    expect(picker).toMatch(/Checkbox/);
    expect(picker).toContain('onLoadMore');
    expect(picker).toContain('加载更早');
    // Newest-first listing with truncated text preview and role labels.
    expect(picker).toMatch(/reverse/);
    expect(picker).toMatch(/slice/);
    expect(picker).toMatch(/用户|助手/);
    expect(picker).not.toContain('/api/auto-memory');
  });

  test('ChatView wires the current conversation into the picker', () => {
    const view = read('web/src/components/chat/ChatView.tsx');
    expect(view).toMatch(/messagePicker=\{\{/);
    expect(view).not.toContain('/api/auto-memory');
  });
});
