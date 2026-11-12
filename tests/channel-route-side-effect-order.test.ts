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
    expectRouteBeforeSideEffects(source('feishu.ts'), 'const admittedRoute =', [
      'await enrichFeishuInboundContent(',
      'onNewChat?.(chatJid, resolvedChatName)',
      'await downloadFeishuImage(',
      'storeMessageDirect(',
    ]);
  });
});
