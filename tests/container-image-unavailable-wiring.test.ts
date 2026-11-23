import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { isContainerImageUnavailableExit } from '../src/container-image-failure';

// ISSUE-20：主路径失败处理接线（源码结构断言，风格同 provider-auth-error.test.ts）。
const read = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
const main = read('src/index.ts');

const IMAGE_BRANCH_ANCHOR =
  'errorDetail.startsWith(CONTAINER_IMAGE_UNAVAILABLE_ERROR_PREFIX)';

function imageBranch(): string {
  const start = main.indexOf(IMAGE_BRANCH_ANCHOR);
  expect(start).toBeGreaterThan(-1);
  return main.slice(start, main.indexOf('// ── OOM auto-recovery', start));
}

describe('镜像不可用分支（拍板 2：立即停止；拍板 3：告知 Web 与 IM）', () => {
  test('位于认证失败分支之后、OOM 与静默重试之前', () => {
    const auth = main.indexOf('isPermanentProviderAuthError(errorDetail)');
    const image = main.indexOf(IMAGE_BRANCH_ANCHOR);
    const oom = main.indexOf('// ── OOM auto-recovery');
    const silentRetry = main.indexOf('queue.willRetryAfterFailure(chatJid)');
    expect(auth).toBeGreaterThan(-1);
    expect(image).toBeGreaterThan(auth);
    expect(oom).toBeGreaterThan(image);
    expect(silentRetry).toBeGreaterThan(image);
  });

  test('Web 工作区收到原因与建议（不含原始错误）', () => {
    const branch = imageBranch();
    expect(branch).toMatch(
      /sendSystemMessage\(\s*chatJid,\s*'agent_error',\s*CONTAINER_IMAGE_UNAVAILABLE_USER_NOTICE,?\s*\)/,
    );
    expect(branch).not.toMatch(/sendSystemMessage\([^)]*errorDetail/);
  });

  test('沿当前 Turn 的 IM 路由发同文案，不在 Web 重复存一条', () => {
    const branch = imageBranch();
    expect(branch).toContain('deliverContainerImageUnavailableNotice(');
    expect(branch).toContain('channelOutboxScopesByInput.get(');
    expect(branch).toContain('replySourceImJid');

    const start = main.indexOf(
      'async function deliverContainerImageUnavailableNotice(',
    );
    expect(start).toBeGreaterThan(-1);
    const helper = main.slice(start, main.indexOf('\n}\n', start));
    expect(helper).toContain('resolveSystemNoticeRoute(');
    expect(helper).toContain('deliverIndependentChannelSystemNotice(');
    expect(helper).toContain("noticeKey: 'container-image-unavailable'");
    expect(helper).toContain('text: CONTAINER_IMAGE_UNAVAILABLE_USER_NOTICE');
    expect(helper).toContain('storeMessage: false');
    // Web-only 会话没有 IM 路由时不发
    expect(helper).toContain('if (!input.targetJid || !route) return false;');
  });

  test('主动尾部中断通知复用同一路由解析（行为不变）', () => {
    const start = main.indexOf(
      'async function deliverProactiveTailInterruptionNotice(',
    );
    const body = main.slice(start, main.indexOf('\n}\n', start));
    expect(body).toContain(
      'resolveSystemNoticeRoute(input.scope, input.targetJid)',
    );
    expect(body).toContain("'proactive_interrupted'");
  });

  test('完整收尾：定时任务终态、提交游标、清指示、不重试', () => {
    const branch = imageBranch();
    expect(branch).toContain('projectCurrentScheduledGroupTerminal(');
    expect(branch).toContain('commitCursor()');
    expect(branch).toContain('clearProcessingIndicatorForInput');
    expect(branch).toContain('return true;');
  });
});

describe('其他失败的现有行为不变（回归）', () => {
  test('OOM：仍按 /code 137/ 识别并计数，阈值自动重置会话', () => {
    expect(main).toContain('const OOM_EXIT_RE = /code 137/;');
    const oom = main.slice(
      main.indexOf('// ── OOM auto-recovery'),
      main.indexOf('queue.willRetryAfterFailure(chatJid)'),
    );
    expect(oom).toContain('OOM_EXIT_RE.test(errorDetail)');
    expect(oom).toContain('OOM_AUTO_RESET_THRESHOLD');
    expect(oom).toContain("'context_reset'");
  });

  test('普通失败：仍静默退避重试，末轮才发 agent_error 原文', () => {
    const start = main.indexOf('queue.willRetryAfterFailure(chatJid)');
    const tail = main.slice(start, start + 1500);
    expect(tail).toContain(
      'Agent error (no reply sent), will retry silently with backoff',
    );
    expect(tail).toContain("statusText: 'idle'");
    expect(tail).toContain(
      "sendSystemMessage(chatJid, 'agent_error', errorDetail)",
    );
    expect(tail).toContain('return false;');
  });

  test('重试耗尽：onMaxRetriesExceeded 仍只发 agent_max_retries', () => {
    expect(main).toContain(
      "sendSystemMessage(groupJid, 'agent_max_retries', error)",
    );
    const queue = read('src/group-queue.ts');
    expect(queue).toContain('const MAX_RETRIES = 5;');
    expect(queue).toContain('const BASE_RETRY_MS = 5000;');
  });

  test('普通退出码、OOM、超时、信号不会被识别为镜像不可用', () => {
    const imageStderr = 'pull access denied for x/y';
    expect(isContainerImageUnavailableExit('code 1', imageStderr)).toBe(false);
    expect(isContainerImageUnavailableExit('code 137', imageStderr)).toBe(
      false,
    );
    expect(isContainerImageUnavailableExit('signal SIGTERM', imageStderr)).toBe(
      false,
    );
    // 超时走 handleTimeoutClose，错误串不经过 exitLabel 分类
    expect(read('src/agent-output-parser.ts')).toContain(
      'error: `${ctx.label} timed out after ${ctx.timeoutMs}ms`',
    );
  });
});

describe('启动期预检（拍板 4）', () => {
  test('ensureDockerRunning 在 Docker 可用后检查镜像并告警', () => {
    const start = main.indexOf('async function ensureDockerRunning()');
    expect(start).toBeGreaterThan(-1);
    const body = main.slice(start, main.indexOf('\n}\n', start));
    const available = body.indexOf('isDockerAvailable()');
    const preflight = body.indexOf('warnIfContainerImageMissing(');
    expect(available).toBeGreaterThan(-1);
    expect(preflight).toBeGreaterThan(available);
    expect(body).toContain('image: CONTAINER_IMAGE');
  });
});
