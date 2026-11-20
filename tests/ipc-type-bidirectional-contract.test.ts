import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * 契约测试（ISSUE-13 §B.2）：`container/agent-runner/src/mcp-tools.ts` 发出的
 * 每个 IPC 请求 `type` 在 `src/index.ts` 中都要有处理分支；反过来，宿主的每个
 * 处理分支也要有对应的发送方。
 *
 * 已知缺口进 `KNOWN_GAPS` 白名单，每条注明 issue 号与缺口方向；对应 issue 完成
 * 后必须删除条目（防白名单腐化断言会在条目不再描述现实时报红）。
 * 失败处置指引：删除一个 IPC 生产者（MCP 工具）时，必须同步删除宿主的处理分支
 * （或登记白名单挂 issue 号）；新增处理分支时必须有 runner 侧发送方。
 */

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

/**
 * 已知缺口白名单。gap 方向：
 * - `no-sender`：宿主有处理分支、runner 无发送方；
 * - `no-handler`：runner 有发送方、宿主无处理分支。
 */
const KNOWN_GAPS: Record<
  string,
  { issue: string; gap: 'no-sender' | 'no-handler' }
> = {
  refresh_groups: {
    issue: 'ISSUE-07 第 8 项（旧容器镜像滚动升级兼容候选，去留待用户拍板）',
    gap: 'no-sender',
  },
};

const mcpToolsSource = readFileSync(
  path.join(repoRoot, 'container/agent-runner/src/mcp-tools.ts'),
  'utf-8',
);
const indexSource = readFileSync(path.join(repoRoot, 'src/index.ts'), 'utf-8');

/** runner 侧发送方：`type: '<lit>'` 字面量（排除 content 块的 as const 行）∪ callAgentBuilder('<lit>')。 */
function extractSenders(): Set<string> {
  const senders = new Set<string>();
  for (const line of mcpToolsSource.split('\n')) {
    // content 块的 `type: 'text' as const` 是消息内容格式，不是 IPC 请求类型。
    if (line.includes('as const')) continue;
    for (const m of line.matchAll(/type: '([a-z_]+)'/g)) senders.add(m[1]);
  }
  for (const m of mcpToolsSource.matchAll(/callAgentBuilder\('([a-z_]+)'/g))
    senders.add(m[1]);
  return senders;
}

/** 宿主侧处理分支：tasks 目录 IPC 的顶层 switch case（4 空格缩进）∪ messages 目录的条件分支。 */
function extractHandlers(): Set<string> {
  const handlers = new Set<string>();
  const lines = indexSource.split('\n');
  const switchLine = lines.findIndex((l) => l.includes('switch (data.type)'));
  for (let i = switchLine; i < lines.length; i++) {
    // 顶层 switch 以 4 空格 case/default 为界；嵌套 operation 分支缩进更深，不属于请求类型。
    if (/^ {4}default:/.test(lines[i])) break;
    const m = lines[i].match(/^ {4}case '([a-z_]+)':/);
    if (m) handlers.add(m[1]);
  }
  // messages 目录的投递 watcher 用条件分支而非 switch。
  for (const m of indexSource.matchAll(/data\.type === '([a-z_]+)'/g))
    handlers.add(m[1]);
  return handlers;
}

describe('IPC type bidirectional contract (ISSUE-13 §B.2)', () => {
  const senders = extractSenders();
  const handlers = extractHandlers();
  const gapKeys = new Set(Object.keys(KNOWN_GAPS));

  test('scanner anchors hold (unique dispatch, plausible set sizes)', () => {
    // 结构锚点：分发 switch 恰好一处、集合规模合理——锚点漂移时先更新扫描器再谈契约。
    expect([...indexSource.matchAll(/switch \(data\.type\)/g)].length).toBe(1);
    expect(senders.size).toBeGreaterThanOrEqual(20);
    expect(handlers.size).toBeGreaterThanOrEqual(20);
    expect(senders).toContain('schedule_task');
    expect(handlers).toContain('schedule_task');
  });

  test('every runner-sent IPC type has a host handler (or a whitelisted issue)', () => {
    const missing = [...senders].filter(
      (type) => !handlers.has(type) && !gapKeys.has(type),
    );
    expect(
      missing,
      `以下 runner 发出的 IPC type 在宿主没有处理分支：${missing.join(', ')}。` +
        '宿主若删除处理分支，必须同步下线 runner 侧发送方；缺口请登记 KNOWN_GAPS 并注明 issue 号。',
    ).toEqual([]);
  });

  test('every host handler has a runner sender (or a whitelisted issue)', () => {
    const missing = [...handlers].filter(
      (type) => !senders.has(type) && !gapKeys.has(type),
    );
    expect(
      missing,
      `以下宿主处理分支没有 runner 发送方：${missing.join(', ')}。` +
        '删除 runner 侧工具时必须同步处理宿主分支，或登记 KNOWN_GAPS 挂 issue 号。',
    ).toEqual([]);
  });

  test('every whitelisted gap still describes reality (whitelist anti-rot)', () => {
    const obsolete: string[] = [];
    for (const [type, entry] of Object.entries(KNOWN_GAPS)) {
      if (entry.gap === 'no-sender') {
        // 条目成立条件：处理分支仍在、发送方仍未出现。
        if (!handlers.has(type) || senders.has(type)) obsolete.push(type);
      } else {
        if (!senders.has(type) || handlers.has(type)) obsolete.push(type);
      }
    }
    expect(
      obsolete,
      `以下白名单条目已不再描述现实（对应 issue 可能已完成），请删除条目：${obsolete.join(', ')}。`,
    ).toEqual([]);
  });
});
