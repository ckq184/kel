import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';

/**
 * ISSUE-11 A 部分契约测试：兼容层下线。
 *
 * ① 已删路由不复活（grep 源码断言）：user-im 死门面（QQ 7 条、微信 5 条、
 *    GET feishu、迁移后的 status / PUT feishu）、旧入口 7 条、/agents 写路由
 *    5 条。保留面用正向锚点锁定：`GET /:jid/agents`、`PUT/POST
 *    /user-im/bindings…` 与现行 tasks `/runs` 入口必须在位。
 * ② channel-accounts 连接派生逻辑单测：旧 GET /api/config/user-im/status
 *    返回 `{feishu,qq,wechat}`（imManager 单例连接器活跃布尔）；迁移后由
 *    `GET /api/channel-accounts` 的账号列表派生，规则 = 某 provider 存在
 *    `status === 'connected'` 的账号即为 true（后端 `projectedTransportStatus`
 *    以同一活跃连接探测投影 `status`，语义与旧 isXConnected 对齐）。
 * ③ 本文件为 ISSUE-11 系列契约测试的宿主文件，B 部分与 A4 子任务会继续追加。
 */

const root = path.resolve(import.meta.dirname, '..');
const read = (relative: string) =>
  fs.readFileSync(path.join(root, relative), 'utf8');

// ─────────────────────────────────────────────────────── ① 已删路由不复活

describe('removed legacy routes stay removed (ISSUE-11 A1/A2/A3)', () => {
  test('config.ts no longer registers the dead user-im facade or compat config entries', () => {
    const source = read('src/routes/config.ts');
    for (const pattern of [
      // 迁移后删除：GET status、GET/PUT feishu（渠道账号化）
      /configRoutes\.get\(\s*['`]\/user-im\/status['`]/,
      /configRoutes\.get\(\s*['`]\/user-im\/feishu['`]/,
      /configRoutes\.put\(\s*['`]\/user-im\/feishu['`]/,
      // QQ 7 条
      /configRoutes\.(get|put)\(\s*['`]\/user-im\/qq['`]/,
      /configRoutes\.post\(\s*['`]\/user-im\/qq\/test['`]/,
      /configRoutes\.post\(\s*['`]\/user-im\/qq\/pairing-code['`]/,
      /configRoutes\.(get|put|delete)\(\s*['`]\/user-im\/qq\/paired-chats/,
      // 微信 5 条
      /configRoutes\.(get|put)\(\s*['`]\/user-im\/wechat['`]/,
      /configRoutes\.post\(\s*['`]\/user-im\/wechat\/(qrcode|disconnect)['`]/,
      /configRoutes\.get\(\s*['`]\/user-im\/wechat\/qrcode-status['`]/,
      // 旧入口：GET /claude、PUT /claude/custom-env、GET/PUT /feishu
      /configRoutes\.get\(\s*['`]\/claude['`]/,
      /configRoutes\.put\(\s*['`]\/claude\/custom-env['`]/,
      /configRoutes\.(get|put)\(\s*['`]\/feishu['`]/,
    ]) {
      expect(source).not.toMatch(pattern);
    }
  });

  test('config.ts keeps the live user-im binding routes (user decision #3)', () => {
    const source = read('src/routes/config.ts');
    expect(source).toContain("configRoutes.put('/user-im/bindings/:imJid'");
    expect(source).toContain("'/user-im/bindings/:imJid/reset-allowlist'");
  });

  test('tasks.ts no longer registers parse / logs / legacy run entries', () => {
    const source = read('src/routes/tasks.ts');
    expect(source).not.toMatch(/tasksRoutes\.post\(\s*['`]\/parse['`]/);
    expect(source).not.toMatch(/tasksRoutes\.get\(\s*['`]\/:id\/logs['`]/);
    // `'/:id/run',` 带逗号锚定，避免误伤现行 `'/:id/runs'` 入口。
    expect(source).not.toMatch(/tasksRoutes\.post\(\s*['`]\/:id\/run['`],/);
  });

  test('agents.ts no longer registers /:jid/agents write routes (GET stays)', () => {
    const source = read('src/routes/agents.ts');
    expect(source).not.toMatch(
      /router\.(post|patch|put|delete)\(\s*['`]\/:jid\/agents/,
    );
    // 保留面正向锚点：读路由与现行 /sessions、/im-binding 写路由仍在。
    expect(source).toContain("router.get('/:jid/agents'");
    expect(source).toContain("router.get('/:jid/sessions'");
    expect(source).toContain("router.put('/:jid/im-binding'");
    expect(source).toContain("router.post('/:jid/im-groups/sync'");
  });

  test('frontend no longer calls the removed user-im endpoints', () => {
    // 断言的是 api 调用点，允许文档注释里提及被移除的路径名。
    const userImCall =
      /api\.(get|post|put|patch|delete)\s*(?:<[^()]*>)?\(\s*['`][^'`]*\/api\/config\/user-im\/(status|feishu)/;
    for (const file of [
      'web/src/hooks/useConnectedChannels.ts',
      'web/src/components/chat/ChatView.tsx',
      'web/src/pages/SetupProvidersPage.tsx',
    ]) {
      expect(read(file)).not.toMatch(userImCall);
    }
    // 仍为正式路由的 bindings 门面保留其前端调用方。
    expect(
      read('web/src/components/settings/hooks/useImBindings.ts'),
    ).toContain('/api/config/user-im/bindings/');
  });
});

// ─────────────────────────────────────────────── ② channel-accounts 派生逻辑

vi.mock('../web/src/api/client', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { deriveConnectedChannels } from '../web/src/hooks/useConnectedChannels';

describe('channel-accounts connected derivation (ISSUE-11 A1)', () => {
  const account = (
    provider: 'feishu' | 'qq' | 'wechat',
    status:
      | 'disconnected'
      | 'connecting'
      | 'reconnecting'
      | 'connected'
      | 'error',
  ) => ({ provider, status });

  test('a provider is connected iff one of its accounts is transport-connected', () => {
    const derived = deriveConnectedChannels([
      account('feishu', 'connected'),
      account('qq', 'reconnecting'),
      account('qq', 'disconnected'),
    ]);
    expect(derived).toEqual({ feishu: true, qq: false, wechat: false });
  });

  test('multiple accounts: a single live account marks the provider connected', () => {
    const derived = deriveConnectedChannels([
      account('qq', 'disconnected'),
      account('qq', 'connected'),
      account('wechat', 'error'),
    ]);
    expect(derived.qq).toBe(true);
    expect(derived.wechat).toBe(false);
  });

  test('empty or missing accounts mean nothing connected (old status default)', () => {
    expect(deriveConnectedChannels([])).toEqual({
      feishu: false,
      qq: false,
      wechat: false,
    });
  });

  test('always returns exactly the three channel keys', () => {
    const derived = deriveConnectedChannels([account('wechat', 'connected')]);
    expect(Object.keys(derived).sort()).toEqual(['feishu', 'qq', 'wechat']);
    expect(derived.wechat).toBe(true);
  });
});

// ─────────────────────────────────────────── ③ A4/A5 契约锁（ISSUE-11）

describe('WS send_message inbound and includeClaudePreset contract stay offline (ISSUE-11 A4/A5)', () => {
  test('web.ts no longer registers a WS send_message inbound dispatch', () => {
    const source = read('src/web.ts');
    // 只断言入站分发注册本身，与 A1 风格一致：注释里提及 send_message
    // 语义（如 MCP/IPC 契约说明）不算复活，不采用整词禁令。
    expect(source).not.toMatch(/msg\.type\s*===\s*['`]send_message['`]/);
    // 正向锚点：WS 消息处理器仍在，terminal_* 四条分发保持注册。
    expect(source).toContain("msg.type === 'terminal_start'");
    expect(source).toContain("msg.type === 'terminal_input'");
    expect(source).toContain("msg.type === 'terminal_resize'");
    expect(source).toContain("msg.type === 'terminal_stop'");
  });

  test('host and runner ContainerInput contracts carry no includeClaudePreset field', () => {
    // 契约层（ContainerInput 线缆声明）已彻底下线；DB prompt_mode 列与
    // profile API 的 include_claude_preset 字段留给 ISSUE-09/10，不在断言面内。
    expect(read('src/container-runner.ts')).not.toMatch(/includeClaudePreset/);
    expect(read('container/agent-runner/src/types.ts')).not.toMatch(
      /includeClaudePreset/,
    );
  });

  test('the retired WS message protocol leaves no type-surface residue', () => {
    // 拍板补充（用户确认连消费端一起下线）：ws_error 出站类型失去唯一
    // 生产方（sendWsError 随处理器删除），ChatView 订阅同步下线；
    // WsMessageIn 只保留 terminal_* 四条；web-context 的 handleSpawnCommand
    // 孤儿 deps 成员移除（IM 主进程 handleCommand 路径不受影响）。
    const types = read('src/types.ts');
    expect(types).not.toMatch(/['`]ws_error['`]/);
    expect(types).not.toMatch(
      /type:\s*['`]send_message['`][^}]*chatJid:\s*string/,
    );
    expect(read('src/web-context.ts')).not.toMatch(/handleSpawnCommand\?/);
    expect(read('web/src/components/chat/ChatView.tsx')).not.toMatch(
      /wsManager\.on\(\s*['`]ws_error['`]/,
    );
  });
});

// ───────────────────────── ④ ISSUE-11 B：重复实现收敛（B3/B4/B5）

// B3 行为测试驱动真实 chat/groups 双 store。A 部分仅 mock 了 api/client，
// 这里补齐 chat.ts 的其余 import 面（files/auth/toast/messageSnapshotCache）。
// vi.mock 整体提升到文件顶部且文件级生效：A 部分用例不依赖这些模块，
// 追加不影响既有用例；groups store 保持真实实现（B3 的断言对象）。
vi.mock('../web/src/stores/files', () => ({
  useFileStore: { getState: () => ({ loadFiles: vi.fn() }) },
}));
vi.mock('../web/src/stores/auth', () => ({
  useAuthStore: { getState: () => ({ user: null }) },
}));
vi.mock('../web/src/utils/toast', () => ({
  showToast: vi.fn(),
  notifyIfHidden: vi.fn(),
  shouldEmitBackgroundTaskNotice: vi.fn(() => false),
  showNotificationPromptToast: vi.fn(),
}));
vi.mock('../web/src/utils/messageSnapshotCache', () => ({
  deleteAgentMessageSnapshot: vi.fn(),
  deleteGroupMessageSnapshots: vi.fn(),
  loadAgentMessageSnapshot: vi.fn(),
  saveAgentMessageSnapshot: vi.fn(),
}));

import { beforeEach } from 'vitest';
import { api } from '../web/src/api/client';
import type { GroupInfo } from '../web/src/types';
import { useChatStore } from '../web/src/stores/chat';
import { useGroupsStore } from '../web/src/stores/groups';
import { extractErrorMessage } from '../web/src/utils/error';

function listWebSources(dir = 'web/src'): string[] {
  const absolute = path.join(root, dir);
  // ISSUE-15：清单字符串按 POSIX 分隔符归一——断言面书写仓库相对 posix 路径，
  // Windows 下 path.join 产出 '\' 会错判（打开文件仍用原生 path.join）。
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory())
      return listWebSources(path.posix.join(dir, entry.name));
    return /\.(ts|tsx)$/.test(entry.name)
      ? [path.posix.join(dir, entry.name)]
      : [];
  });
}

function groupFixture(overrides: Partial<GroupInfo> = {}): GroupInfo {
  return {
    name: '工作区',
    folder: 'ws',
    added_at: '2026-01-01T00:00:00.000Z',
    interaction_mode: 'assistant',
    ...overrides,
  };
}

const SEED_GROUPS: Record<string, GroupInfo> = {
  'g:home': groupFixture({ name: '主页', folder: 'home', is_my_home: true }),
  'g:one': groupFixture({ name: 'One', folder: 'one' }),
};

function seedBothStores(groups: Record<string, GroupInfo>): void {
  useChatStore.setState({ groups: { ...groups }, currentGroup: 'g:one' });
  useGroupsStore.setState({ groups: { ...groups } });
}

function resetGroupsStores(): void {
  useChatStore.setState({
    groups: {},
    currentGroup: null,
    loading: false,
    error: null,
  });
  useGroupsStore.setState({
    groups: {},
    adminHostOnlyMode: false,
    loading: false,
    error: null,
  });
}

// ───────────────────────────── ④.a B3：/api/groups 双 store 统一
//
// ISSUE-06 的正式关闭项：groups store 成为 /api/groups 拉取路径的唯一
// owner（并发去重），chat store 的 loadGroups 委托并镜像结果；
// createFlow / renameFlow / togglePin / deleteFlow 四个写流在更新自身后
// 向 groups store 确定性广播。两份 state 容器保留（组件消费面不动）。

describe('groups double-store convergence (ISSUE-11 B3)', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset();
    vi.mocked(api.post).mockReset();
    vi.mocked(api.patch).mockReset();
    vi.mocked(api.delete).mockReset();
    resetGroupsStores();
  });

  test('chat loadGroups delegates to the groups-store loader and mirrors it', async () => {
    vi.mocked(api.get).mockResolvedValue({
      groups: SEED_GROUPS,
      admin_host_only_mode: true,
    });

    await useChatStore.getState().loadGroups();

    expect(useGroupsStore.getState().groups).toEqual(SEED_GROUPS);
    expect(useChatStore.getState().groups).toEqual(SEED_GROUPS);
    expect(useChatStore.getState().adminHostOnlyMode).toBe(true);
    expect(useGroupsStore.getState().adminHostOnlyMode).toBe(true);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  test('currentGroup stays a chat-store-only concern (home fallback preserved)', async () => {
    vi.mocked(api.get).mockResolvedValue({ groups: SEED_GROUPS });
    useChatStore.setState({ currentGroup: null });

    await useChatStore.getState().loadGroups();

    // currentGroup 语义不随收敛迁移：仍由 chat store 独占维护。
    expect(useChatStore.getState().currentGroup).toBe('g:home');
    expect(useGroupsStore.getState().groups).toEqual(SEED_GROUPS);
  });

  test('concurrent loads from both stores share one in-flight /api/groups request', async () => {
    vi.mocked(api.get).mockResolvedValue({ groups: SEED_GROUPS });

    await Promise.all([
      useChatStore.getState().loadGroups(),
      useGroupsStore.getState().loadGroups(),
    ]);

    expect(api.get).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().groups).toEqual(SEED_GROUPS);
    expect(useGroupsStore.getState().groups).toEqual(SEED_GROUPS);
  });

  test('renameFlow broadcasts the rename to the groups store', async () => {
    seedBothStores(SEED_GROUPS);
    vi.mocked(api.patch).mockResolvedValue({ success: true });

    await useChatStore.getState().renameFlow('g:one', '改名');

    expect(useChatStore.getState().groups['g:one']?.name).toBe('改名');
    expect(useGroupsStore.getState().groups['g:one']?.name).toBe('改名');
  });

  test('togglePin broadcasts the pin state to the groups store', async () => {
    seedBothStores(SEED_GROUPS);
    vi.mocked(api.patch).mockResolvedValue({
      success: true,
      pinned_at: '2026-11-20T00:00:00.000Z',
    });

    await useChatStore.getState().togglePin('g:one');

    expect(useChatStore.getState().groups['g:one']?.pinned_at).toBe(
      '2026-11-20T00:00:00.000Z',
    );
    expect(useGroupsStore.getState().groups['g:one']?.pinned_at).toBe(
      '2026-11-20T00:00:00.000Z',
    );
  });

  test('deleteFlow broadcasts the removal to the groups store', async () => {
    seedBothStores(SEED_GROUPS);
    vi.mocked(api.delete).mockResolvedValue({ success: true });

    await useChatStore.getState().deleteFlow('g:one', {
      unbindChannels: true,
    });

    expect(useChatStore.getState().groups['g:one']).toBeUndefined();
    expect(useGroupsStore.getState().groups['g:one']).toBeUndefined();
    // 删除当前工作区后 chat store 自动回落到剩余工作区（既有语义）。
    expect(useChatStore.getState().currentGroup).toBe('g:home');
  });

  test('createFlow broadcasts the new workspace to the groups store', async () => {
    seedBothStores(SEED_GROUPS);
    vi.mocked(api.post).mockResolvedValue({
      success: true,
      jid: 'g:new',
      group: groupFixture({ name: 'New', folder: 'new' }),
    });

    const result = await useChatStore.getState().createFlow('New');

    expect(result).toEqual({ jid: 'g:new', folder: 'new' });
    expect(useChatStore.getState().groups['g:new']?.name).toBe('New');
    expect(useGroupsStore.getState().groups['g:new']?.name).toBe('New');
  });
});

// ───────────────────────────── ④.b B4：错误提取收敛
//
// 行为统一基准：Error.message 优先 → 对象 .message → String(err)；原文保留
// 不 trim；兜底文案由调用方经可选 fallback 参数传入，仅在提取结果为空时生效。

describe('shared extractErrorMessage fallback contract (ISSUE-11 B4)', () => {
  test('keeps the unified baseline order without trimming', () => {
    expect(extractErrorMessage(new Error('boom '))).toBe('boom ');
    expect(extractErrorMessage({ status: 500, message: '服务器错误' })).toBe(
      '服务器错误',
    );
    expect(extractErrorMessage('plain string')).toBe('plain string');
    expect(extractErrorMessage(new Error('  '))).toBe('  ');
  });

  test('fallback applies only when extraction yields an empty message', () => {
    expect(extractErrorMessage(new Error(''), '兜底文案')).toBe('兜底文案');
    expect(extractErrorMessage('', '兜底文案')).toBe('兜底文案');
    expect(extractErrorMessage({ message: '' }, '兜底文案')).toBe('兜底文案');
    expect(extractErrorMessage(new Error('真实文案'), '兜底文案')).toBe(
      '真实文案',
    );
    // 无 fallback 保持现行为：空提取结果原样返回。
    expect(extractErrorMessage(new Error(''))).toBe('');
  });

  test('API plain-object errors keep their message (McpServerDetail regression)', () => {
    // web/src/api/client.ts 抛 {status, message, body} 普通对象而非 Error
    // 实例；收敛前 McpServerDetail 的本地副本仅认 Error 分支，API 文案被
    // 吞成兜底。共享版必须原样返回 .message。
    const apiError = { status: 409, message: '该名称已被占用', body: {} };
    expect(extractErrorMessage(apiError, '保存失败')).toBe('该名称已被占用');
  });
});

describe('error-extraction copies route through the shared module (ISSUE-11 B4)', () => {
  test('McpServerDetail drops its local copy and passes the original fallbacks', () => {
    const detail = read('web/src/components/mcp-servers/McpServerDetail.tsx');
    expect(detail).not.toMatch(/function errorMessage\(/);
    expect(detail).toContain("from '../../utils/error'");
    expect(detail).toContain("extractErrorMessage(error, '保存 MCP 配置失败')");
    expect(detail).toContain(
      'extractErrorMessage(error, `清空${secretLabel}失败`)',
    );
    expect(detail).toContain(
      "extractErrorMessage(error, '删除 MCP 服务器失败')",
    );
  });

  test('remaining copies keep their fallback texts verbatim', () => {
    // 各副本的兜底文案经 fallback 参数原样迁移（抽样锁定；正则容忍
    // prettier 对长行的折行）。
    expect(read('web/src/stores/usage.ts')).toMatch(
      /extractErrorMessage\(\s*error,\s*'用量数据加载失败，请检查网络后重试。',\s*\)/,
    );
    expect(
      read('web/src/components/agents/AgentPromptAssistant.tsx'),
    ).toContain("extractErrorMessage(err, 'AI 调整失败，请稍后重试')");
    expect(read('web/src/components/users/utils.ts')).not.toMatch(
      /function getErrorMessage\(/,
    );
  });
});

// ───────────────────────────── ④.c B5：formatCost / safeStorage / buildCustomEnv

describe('buildCustomEnv strict synthesis (ISSUE-11 B5, user decision #7)', () => {
  test('accepts uppercase KEY=value lines, trims stored values, keeps embedded =', async () => {
    const { buildCustomEnv } = await import('../web/src/utils/custom-env');
    expect(buildCustomEnv('FOO= bar \nBAZ=qux')).toEqual({
      customEnv: { FOO: 'bar', BAZ: 'qux' },
      error: null,
    });
    expect(buildCustomEnv('FOO=a=b')).toEqual({
      customEnv: { FOO: 'a=b' },
      error: null,
    });
  });

  test('skips blank lines', async () => {
    const { buildCustomEnv } = await import('../web/src/utils/custom-env');
    expect(buildCustomEnv('\n\nFOO=bar\n\n')).toEqual({
      customEnv: { FOO: 'bar' },
      error: null,
    });
  });

  test('rejects lowercase keys (strict Setup semantics now bind ProviderEditor)', async () => {
    const { buildCustomEnv } = await import('../web/src/utils/custom-env');
    const result = buildCustomEnv('foo=bar');
    expect(result.customEnv).toEqual({});
    expect(result.error).toContain('格式无效');
  });

  test('rejects empty values and lines without a KEY=value pair', async () => {
    const { buildCustomEnv } = await import('../web/src/utils/custom-env');
    const emptyValue = buildCustomEnv('FOO=');
    expect(emptyValue.customEnv).toEqual({});
    expect(emptyValue.error).toContain('第 1 行');
    const noPair = buildCustomEnv('FOO');
    expect(noPair.customEnv).toEqual({});
    expect(noPair.error).toContain('第 1 行');
  });

  test('blocks the five reserved keys with the unified message', async () => {
    const { buildCustomEnv, RESERVED_ENV_KEYS } =
      await import('../web/src/utils/custom-env');
    for (const key of RESERVED_ENV_KEYS) {
      const result = buildCustomEnv(`${key}=x`);
      expect(result.customEnv).toEqual({});
      expect(result.error).toContain('已在系统预填列表中');
    }
  });

  test('manageThirdPartyDefaults blocks defaulted third-party keys only when enabled', async () => {
    const { buildCustomEnv } = await import('../web/src/utils/custom-env');
    // CLAUDE_CODE_EFFORT_LEVEL 属于 buildDefaultProviderEnv 的预填默认集。
    const key = 'CLAUDE_CODE_EFFORT_LEVEL';
    expect(
      buildCustomEnv(`${key}=max`, { manageThirdPartyDefaults: true })
        .customEnv,
    ).toEqual({});
    expect(buildCustomEnv(`${key}=max`).customEnv).toEqual({ [key]: 'max' });
  });

  test('rejects duplicate keys and voids the whole package on any error', async () => {
    const { buildCustomEnv } = await import('../web/src/utils/custom-env');
    const duplicated = buildCustomEnv('FOO=bar\nFOO=baz');
    expect(duplicated.customEnv).toEqual({});
    expect(duplicated.error).toContain('重复');
    // 任一错误整包作废：第一行合法也不会被部分保留。
    const voided = buildCustomEnv('FOO=bar\nlower=x');
    expect(voided.customEnv).toEqual({});
    expect(voided.error).toContain('格式无效');
  });
});

describe('shared storage and usage helpers (ISSUE-11 B5)', () => {
  test('safeStorage returns live localStorage and null when inaccessible', async () => {
    const { safeStorage } = await import('../web/src/utils/safe-storage');
    // node 测试环境无 localStorage。
    expect(safeStorage()).toBeNull();

    const stub = { getItem: () => null };
    vi.stubGlobal('localStorage', stub);
    try {
      expect(safeStorage()).toBe(stub);
    } finally {
      vi.unstubAllGlobals();
    }

    // 隐私模式/沙箱下访问可能抛错，回退 null（逐字收敛前的原语义）。
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('denied');
      },
    });
    try {
      expect(safeStorage()).toBeNull();
    } finally {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  test('formatCost keeps the tiered dollar formatting', async () => {
    const { formatCost } = await import('../web/src/utils/usage-format');
    expect(formatCost(1.5)).toBe('$1.50');
    expect(formatCost(0.02)).toBe('$0.020');
    expect(formatCost(0.0001)).toBe('$0.0001');
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(-3)).toBe('$0.00');
  });
});

describe('frontend helper uniqueness contracts (ISSUE-11 B)', () => {
  const webSources = listWebSources();

  test('formatCost / safeStorage / buildCustomEnv are each defined exactly once', () => {
    const defineSites = (pattern: RegExp) =>
      webSources.filter((file) => pattern.test(read(file)));

    expect(defineSites(/function formatCost\(|const formatCost\s*=/)).toEqual([
      'web/src/utils/usage-format.ts',
    ]);
    expect(defineSites(/function safeStorage\(|const safeStorage\s*=/)).toEqual(
      ['web/src/utils/safe-storage.ts'],
    );
    expect(
      defineSites(/function buildCustomEnv\(|const buildCustomEnv\s*=/),
    ).toEqual(['web/src/utils/custom-env.ts']);
  });

  test('named error-extraction copies stay banned outside the whitelist', () => {
    // 白名单三处：共享版本体、settings 区 trim+fallback 语义版、HTTP
    // Response 特化版。其余文件不允许再出现本地命名副本定义形态。
    const whitelist = new Set([
      'web/src/utils/error.ts',
      'web/src/components/settings/types.ts',
      'web/src/utils/download.ts',
    ]);
    const localCopyPattern =
      /function\s+(extractErrorMessage|getApiMessage|getErrorMessage|errorMessage|asMessage)\s*\(|const\s+(extractErrorMessage|getApiMessage|getErrorMessage|errorMessage|asMessage)\s*=\s*\(/;

    const offenders = webSources
      .filter((file) => !whitelist.has(file))
      .filter((file) => localCopyPattern.test(read(file)));

    expect(offenders).toEqual([]);
  });

  test('converged consumers import the shared modules', () => {
    expect(read('web/src/components/usage/UsageTrendChart.tsx')).toContain(
      "from '../../utils/usage-format'",
    );
    expect(read('web/src/pages/UsagePage.tsx')).toContain(
      "from '../utils/usage-format'",
    );
    expect(read('web/src/utils/routeRestore.ts')).toContain(
      "from './safe-storage'",
    );
    expect(read('web/src/utils/workspaceLastAgent.ts')).toContain(
      "from './safe-storage'",
    );
    expect(read('web/src/components/settings/ProviderEditor.tsx')).toContain(
      "from '../../utils/custom-env'",
    );
    expect(read('web/src/pages/SetupProvidersPage.tsx')).toContain(
      "from '../utils/custom-env'",
    );
  });
});
