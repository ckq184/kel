import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  isPermanentProviderAuthError,
  PROVIDER_AUTH_USER_NOTICE,
} from '../src/provider-failure';

describe('isPermanentProviderAuthError', () => {
  // 正例：2026-11-09 生产实测的智谱 401（会话 JSONL 原文形态）
  test('智谱 Anthropic 端点 401 实测串命中', () => {
    expect(
      isPermanentProviderAuthError(
        '401 {"error":{"message":"令牌已过期或验证不正确","type":"401"}}',
      ),
    ).toBe(true);
  });

  test('403 行首命中', () => {
    expect(
      isPermanentProviderAuthError('403 {"error":{"message":"forbidden"}}'),
    ).toBe(true);
  });

  test('Anthropic 官方 invalid x-api-key 文案命中', () => {
    expect(
      isPermanentProviderAuthError('authentication_error: invalid x-api-key'),
    ).toBe(true);
  });

  test('被包装的 authentication_failed 命中（非行首形态）', () => {
    expect(
      isPermanentProviderAuthError(
        'Host agent exited with code 1: authentication_failed',
      ),
    ).toBe(true);
  });

  test('invalid_api_key 蛇形文案命中', () => {
    expect(isPermanentProviderAuthError('api error: invalid_api_key')).toBe(
      true,
    );
  });

  test('智谱中文令牌文案命中（防包装形态兜底）', () => {
    expect(
      isPermanentProviderAuthError('上游返回：令牌已过期或验证不正确'),
    ).toBe(true);
  });

  // 反例：瞬时/无关错误不得命中，否则丢失重试机会
  test('5xx 服务端错误不命中', () => {
    expect(isPermanentProviderAuthError('500 {"error":"internal"}')).toBe(
      false,
    );
    expect(isPermanentProviderAuthError('503 Service Unavailable')).toBe(false);
  });

  test('429 限流不命中（可恢复）', () => {
    expect(isPermanentProviderAuthError('429 {"error":"rate limited"}')).toBe(
      false,
    );
  });

  test('overloaded 不命中', () => {
    expect(isPermanentProviderAuthError('529 overloaded_error')).toBe(false);
  });

  test('网络错误不命中', () => {
    expect(isPermanentProviderAuthError('fetch failed: ECONNREFUSED')).toBe(
      false,
    );
    expect(isPermanentProviderAuthError('request timeout after 30000ms')).toBe(
      false,
    );
  });

  test('无关文本中的 401 数字不误伤', () => {
    expect(isPermanentProviderAuthError('prompt contains 401 tokens')).toBe(
      false,
    );
    expect(isPermanentProviderAuthError('context budget is 14013 tokens')).toBe(
      false,
    );
  });

  test('空串不命中', () => {
    expect(isPermanentProviderAuthError('')).toBe(false);
  });
});

describe('PROVIDER_AUTH_USER_NOTICE', () => {
  test('文案指向 API Key 配置且说明已跳过重试', () => {
    expect(PROVIDER_AUTH_USER_NOTICE).toContain('API Key');
    expect(PROVIDER_AUTH_USER_NOTICE).toContain('已跳过自动重试');
  });
});

describe('index.ts 错误分类通道接线（源码结构断言，风格同 turn-outcome.test.ts）', () => {
  test('认证错误通道位于 agent_profile_unavailable 之后且完整收尾', () => {
    const main = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );
    const anchor = main.indexOf(
      "errorDetail.startsWith('agent_profile_unavailable:')",
    );
    expect(anchor).toBeGreaterThan(-1);
    const branch = main.slice(anchor, main.indexOf('// ── OOM auto-recovery'));

    expect(branch).toContain('isPermanentProviderAuthError(errorDetail)');
    expect(branch).toContain("sendSystemMessage(chatJid, 'agent_error'");
    expect(branch).toContain('commitCursor()');
    expect(branch).toContain('clearProcessingIndicatorForInput');
    expect(branch).toContain('return true;');
    // 通道必须先于静默重试分支（willRetryAfterFailure）判定，否则永远走不到
    const silentRetry = main.indexOf('queue.willRetryAfterFailure(chatJid)');
    const authChannel = main.indexOf(
      'isPermanentProviderAuthError(errorDetail)',
    );
    expect(authChannel).toBeGreaterThan(-1);
    expect(silentRetry).toBeGreaterThan(authChannel);
  });
});
