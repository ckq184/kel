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
