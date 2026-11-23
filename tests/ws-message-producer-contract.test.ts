import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * 契约测试（ISSUE-16 §B）：WS 下行消息的生产者/消费者双向对齐。
 *
 * ISSUE-13 的三个契约测试覆盖了 StreamEvent、IPC 类型与 HTTP 路由，但没有
 * 覆盖 WS 下行消息，`group_created` 因此出现过“生产者被删、消费端还在订阅”
 * 的掉线逻辑而无测试拦截（ISSUE-16 §A）。本测试锁定：
 *
 * 1. `src/types.ts` 的 `WsMessageOut` 联合中每个 `type`，在 `src/`（排除
 *    `src/types.ts`）里至少有一个 `type: '<t>'` 生产点；
 * 2. 每个 `type` 在 `web/src/` 里至少有一个 `wsManager.on('<t>'` 消费点；
 * 3. 反向：`web/src/` 订阅的每个类型都必须属于 `WsMessageOut`（本地生命周期
 *    事件除外，见 LOCAL_LIFECYCLE_EVENTS）。
 *
 * 消费点盘点（2026-11-23）：Web 端唯一的 WS 分发入口是 `web/src/api/ws.ts`
 * 的 `wsManager`，它按 `data.type` 调 `emit`；所有订阅都写作
 * `wsManager.on('<type>', ...)`（参数可换行）。若将来出现新的分发写法
 * （store 内 switch 等），需同步扩展 `collectConsumers` 的扫描规则。
 *
 * 失败处置：删除某消息的生产者时，必须同时处理消费端；掉线逻辑（消费者
 * 还在、生产者没了）不得直接删，先登记、由用户决定补生产者还是连消费端
 * 一起下线。确需暂留的缺口进 KNOWN_GAPS，每条注明 issue 编号，对应 issue
 * 完成后删除条目。
 */

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

/** 已知缺口白名单：类型 → 挂靠的 issue（完成后删除条目）。
 *
 * ISSUE-16 §A 落地（补回 group_created 生产者）后为空。 */
const KNOWN_GAPS: Record<string, string> = {};

/** `wsManager` 自身在连接建立/断开时本地 emit 的生命周期事件（web/src/api/ws.ts），
 * 不是服务端下行消息，不进 WsMessageOut。 */
const LOCAL_LIFECYCLE_EVENTS = new Set(['connected', 'disconnected']);

const read = (relativePath: string) =>
  readFileSync(path.join(repoRoot, relativePath), 'utf-8').replace(
    /\r\n/g,
    '\n',
  );

/** 从真相源提取 WsMessageOut 联合的全部 `type` 判别值。 */
function extractWsMessageTypes(): string[] {
  const source = read('src/types.ts');
  const start = source.indexOf('export type WsMessageOut =');
  const end = source.indexOf('export type WsMessageIn', start);
  expect(
    start >= 0 && end > start,
    'WsMessageOut 联合类型应存在于 src/types.ts 且位于 WsMessageIn 之前（若结构改写，需同步更新本测试的提取器）',
  ).toBe(true);
  const block = source.slice(start, end);
  return [
    ...new Set([...block.matchAll(/\btype: '([a-z_]+)'/g)].map((m) => m[1])),
  ];
}

function walkFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(p, exts));
      continue;
    }
    if (
      exts.some((ext) => entry.name.endsWith(ext)) &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test.tsx')
    ) {
      out.push(p);
    }
  }
  return out;
}

function relative(p: string): string {
  return path.relative(repoRoot, p).split(path.sep).join('/');
}

/** 生产点：src/ 中 `type: '<t>'` 字面量（排除类型定义文件本身）。 */
function collectProducers(types: string[]): Map<string, string[]> {
  const producers = new Map<string, string[]>(types.map((t) => [t, []]));
  for (const file of walkFiles(path.join(repoRoot, 'src'), ['.ts'])) {
    const rel = relative(file);
    if (rel === 'src/types.ts') continue;
    const source = readFileSync(file, 'utf-8');
    for (const t of types) {
      if (new RegExp(`\\btype:\\s*'${t}'`).test(source)) {
        producers.get(t)!.push(rel);
      }
    }
  }
  return producers;
}

/** 消费点：web/src/ 中 `wsManager.on('<t>'`（允许参数换行）。 */
function collectConsumers(): Map<string, string[]> {
  const consumers = new Map<string, string[]>();
  for (const file of walkFiles(path.join(repoRoot, 'web/src'), [
    '.ts',
    '.tsx',
  ])) {
    const source = readFileSync(file, 'utf-8');
    for (const m of source.matchAll(/wsManager\.on\(\s*'([a-z_]+)'/g)) {
      const list = consumers.get(m[1]) ?? [];
      list.push(relative(file));
      consumers.set(m[1], list);
    }
  }
  return consumers;
}

const GUIDANCE =
  '删除 WS 消息的生产者时必须同时处理 Web 消费端；掉线逻辑（消费者还在、生产者没了）' +
  '不得直接删，先登记、由用户决定补生产者还是连消费端一起下线，确需暂留时登记进 ' +
  'KNOWN_GAPS 并注明 issue 编号。';

describe('WS 下行消息生产者/消费者契约（ISSUE-16 §B）', () => {
  const types = extractWsMessageTypes();
  const producers = collectProducers(types);
  const consumers = collectConsumers();

  test('提取器能读到 WsMessageOut 的成员', () => {
    expect(types.length).toBeGreaterThan(10);
    expect(types).toContain('new_message');
    expect(types).toContain('group_created');
  });

  test('每个 WsMessageOut 类型在 src/ 都至少有一个生产点', () => {
    const missing = types.filter(
      (t) => producers.get(t)!.length === 0 && !(t in KNOWN_GAPS),
    );
    expect(
      missing,
      `以下 WS 消息在 src/ 无生产点：${missing.join(', ')}。${GUIDANCE}`,
    ).toEqual([]);
  });

  test('每个 WsMessageOut 类型在 web/src/ 都至少有一个消费点', () => {
    const missing = types.filter(
      (t) => !consumers.has(t) && !(t in KNOWN_GAPS),
    );
    expect(
      missing,
      `以下 WS 消息在 web/src/ 无 wsManager.on 订阅：${missing.join(', ')}。` +
        '新增下行消息需同时接入消费端，或从 WsMessageOut 删除；' +
        GUIDANCE,
    ).toEqual([]);
  });

  test('web/src/ 订阅的每个类型都属于 WsMessageOut', () => {
    const unknown = [...consumers.keys()].filter(
      (t) => !LOCAL_LIFECYCLE_EVENTS.has(t) && !types.includes(t),
    );
    expect(
      unknown,
      `以下订阅类型不在 src/types.ts 的 WsMessageOut 中：${unknown
        .map((t) => `${t}（${consumers.get(t)!.join(', ')}）`)
        .join('；')}。${GUIDANCE}`,
    ).toEqual([]);
  });

  test('本地生命周期事件确实由 web/src/api/ws.ts 本地 emit', () => {
    const ws = read('web/src/api/ws.ts');
    for (const event of LOCAL_LIFECYCLE_EVENTS) {
      expect(ws).toContain(`this.emit('${event}'`);
    }
  });

  test('KNOWN_GAPS 每条都注明 issue 编号且确实仍是缺口', () => {
    for (const [t, issue] of Object.entries(KNOWN_GAPS)) {
      expect(issue, `${t} 的白名单条目必须注明 issue 编号`).toMatch(
        /ISSUE-\d+/,
      );
      const closed = producers.get(t)?.length !== 0 && consumers.has(t);
      expect(closed, `${t} 已有生产者与消费者，请从 KNOWN_GAPS 删除`).toBe(
        false,
      );
    }
    expect(KNOWN_GAPS).not.toHaveProperty('group_created');
  });
});
