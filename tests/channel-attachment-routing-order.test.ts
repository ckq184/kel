import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const read = (relative: string) =>
  fs.readFileSync(path.join(root, relative), 'utf8');

function section(source: string, start: string, end?: string): string {
  const from = source.indexOf(start);
  expect(from, `missing section ${start}`).toBeGreaterThanOrEqual(0);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  expect(to, `missing section end ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

function expectRouteBefore(
  source: string,
  sideEffects: string[],
  gate?: string,
): void {
  const route = source.indexOf('resolveAdmittedChannelRoute(');
  expect(route).toBeGreaterThanOrEqual(0);
  if (gate) expect(source.indexOf(gate)).toBeLessThan(route);
  for (const effect of sideEffects) {
    const index = source.indexOf(effect);
    expect(index, `missing side effect ${effect}`).toBeGreaterThan(route);
  }
}

describe('attachment routing is fail-closed before business side effects', () => {
  test('QQ resolves direct and group routes before registration/download', () => {
    // ISSUE-12 单元 2.15：C2C/群两 handler 镜像合一为
    // processQQInboundMessage（kind 双态保留），路由顺序契约等强改锚
    // src/qq-inbound.ts 的合一函数切片——gate 与双副作用断言文本逐字不变；
    // 合一体保持 isChatAuthorized → resolveAdmittedChannelRoute →
    // storeChatMetadata / processQQAttachment 的顺序不变量，C2C 与群
    // 两态共用同一函数体。
    const source = read('src/qq-inbound.ts');
    expectRouteBefore(
      section(
        source,
        'async function processQQInboundMessage(',
        'async function handleC2CMessage(',
      ),
      ['storeChatMetadata(jid', 'processQQAttachment('],
      'isChatAuthorized(jid)',
    );
  });

  test('WeChat resolves before chat registration and media processing', () => {
    // ISSUE-12 单元 2.20：微信入站管线随 processMessage 自 src/wechat.ts
    // 原文搬至 src/wechat-inbound.ts，路由顺序契约等强改锚新模块的
    // processMessage 切片——gate 与双副作用断言文本逐字不变。
    expectRouteBefore(
      section(read('src/wechat-inbound.ts'), 'async function processMessage('),
      ['storeChatMetadata(jid', 'processImageItem('],
      'isChatAuthorized?.(jid)',
    );
  });
});
