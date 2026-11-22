import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

function source(file: string) {
  return fs.readFileSync(path.join(process.cwd(), 'src', file), 'utf8');
}

function expectRouteBeforeSideEffects(
  body: string,
  routeMarker: string,
  markers: string[],
) {
  const route = body.indexOf(routeMarker);
  expect(route).toBeGreaterThan(-1);
  for (const marker of markers) {
    const sideEffect = body.indexOf(marker, route);
    expect(sideEffect, marker).toBeGreaterThan(route);
  }
}

describe('stale routes are rejected before connector side effects', () => {
  test('Feishu resolves before registration, downloads, and persistence', () => {
    // ISSUE-12 单元 2.9：附件段（await downloadFeishuImage 调用形）自
    // src/feishu.ts 原文搬至 src/feishu-inbound-attachments.ts，本用例的
    // 下载侧效 marker 等强改锚为管道侧委托调用形——它在同一管道位置触发
    // 下载，顺序断言（admittedRoute 先于注册 / 下载 / 持久化）与搬迁前
    // 逐字等价；downloadFeishuImage 真实调用形由下一用例锚新模块，两锚
    // 联合等强于原单锚（route → 委托 → 下载三跳全锁）。
    expectRouteBeforeSideEffects(source('feishu.ts'), 'const admittedRoute =', [
      'await enrichFeishuInboundContent(',
      'onNewChat?.(chatJid, resolvedChatName)',
      'await downloadFeishuInboundAttachments(',
      'storeMessageDirect(',
    ]);
  });

  test('Feishu attachment module keeps the image download call form（单元 2.9 改锚）', () => {
    // 原 'await downloadFeishuImage(' 文本随附件段迁入新模块；配合上一用例
    // 的委托调用锚构成等强迁移（无断言删除，锚点随搬运体搬家）。
    expect(source('feishu-inbound-attachments.ts')).toContain(
      'await downloadFeishuImage(',
    );
  });
});
