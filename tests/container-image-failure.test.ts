import { describe, test, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  CONTAINER_IMAGE_UNAVAILABLE_ERROR_PREFIX,
  CONTAINER_IMAGE_UNAVAILABLE_USER_NOTICE,
  buildContainerExitError,
  isContainerImageUnavailableExit,
  summarizeStderr,
  warnIfContainerImageMissing,
} from '../src/container-image-failure';

// 2026-11-23 ISSUE-14 实机日志中的 docker run stderr 原文形态
const PULL_DENIED_STDERR =
  "Unable to find image 'ckq184/ckqclaw-agent:latest' locally\n" +
  'docker: Error response from daemon: pull access denied for ckq184/ckqclaw-agent, ' +
  "repository does not exist or may require 'docker login': denied: requested access to the resource is denied.\n" +
  "See 'docker run --help'.\n";

describe('isContainerImageUnavailableExit', () => {
  test('实机形态：125 + pull access denied 命中', () => {
    expect(
      isContainerImageUnavailableExit('code 125', PULL_DENIED_STDERR),
    ).toBe(true);
  });

  test.each([
    "Unable to find image 'foo/bar:latest' locally",
    'docker: Error response from daemon: manifest unknown: manifest unknown.',
    'Error response from daemon: manifest for foo/bar:latest not found: manifest unknown',
    'docker: Error response from daemon: repository foo/bar not found: name unknown.',
    "repository does not exist or may require 'docker login'",
  ])('125 + 镜像不可用文案命中：%s', (stderr) => {
    expect(isContainerImageUnavailableExit('code 125', stderr)).toBe(true);
  });

  test('125 + 挂载/参数错误不命中（仍走重试，用户拍板 1）', () => {
    expect(
      isContainerImageUnavailableExit(
        'code 125',
        'docker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: /data/x.',
      ),
    ).toBe(false);
    expect(
      isContainerImageUnavailableExit(
        'code 125',
        'docker: invalid reference format.',
      ),
    ).toBe(false);
  });

  test('非 125 退出即使 stderr 含镜像文案也不命中', () => {
    expect(isContainerImageUnavailableExit('code 1', PULL_DENIED_STDERR)).toBe(
      false,
    );
    expect(
      isContainerImageUnavailableExit('code 137', PULL_DENIED_STDERR),
    ).toBe(false);
    expect(
      isContainerImageUnavailableExit('signal SIGKILL', PULL_DENIED_STDERR),
    ).toBe(false);
    expect(
      isContainerImageUnavailableExit('code 1250', PULL_DENIED_STDERR),
    ).toBe(false);
  });

  test('空 stderr 不命中', () => {
    expect(isContainerImageUnavailableExit('code 125', '')).toBe(false);
  });
});

describe('summarizeStderr（用户拍板 5：保留首尾）', () => {
  test('不超过 2*edge 原样返回', () => {
    const s = 'a'.repeat(400);
    expect(summarizeStderr(s)).toBe(s);
    expect(summarizeStderr('')).toBe('');
  });

  test('超长时保留开头与结尾，中间用省略号连接', () => {
    const head = 'H'.repeat(200);
    const tail = 'T'.repeat(200);
    const out = summarizeStderr(`${head}${'M'.repeat(1000)}${tail}`);
    expect(out).toBe(`${head}…${tail}`);
  });

  test('实机 stderr 截断后仍保留镜像名开头', () => {
    const long = PULL_DENIED_STDERR + 'x'.repeat(500);
    expect(summarizeStderr(long)).toContain(
      "Unable to find image 'ckq184/ckqclaw-agent:latest'",
    );
  });

  test('可自定义 edge', () => {
    expect(summarizeStderr('abcdefghij', 2)).toBe('ab…ij');
  });
});

describe('buildContainerExitError', () => {
  test('镜像不可用：错误串带前缀，result 为空', () => {
    const out = buildContainerExitError(PULL_DENIED_STDERR, 'code 125');
    expect(out.result).toBeNull();
    expect(out.error.startsWith(CONTAINER_IMAGE_UNAVAILABLE_ERROR_PREFIX)).toBe(
      true,
    );
    expect(out.error).toContain('Container exited with code 125');
    expect(out.error).toContain('pull access denied');
  });

  test('普通退出：保持原错误形态（不带前缀），OOM 仍能被 /code 137/ 识别', () => {
    const plain = buildContainerExitError('boom', 'code 1');
    expect(plain).toEqual({
      result: null,
      error: 'Container exited with code 1: boom',
    });
    const oom = buildContainerExitError('', 'code 137');
    expect(oom.error).toBe('Container exited with code 137: ');
    expect(/code 137/.test(oom.error)).toBe(true);
  });

  test('非镜像类 125 不带前缀', () => {
    const out = buildContainerExitError('invalid mount config', 'code 125');
    expect(out.error).toBe(
      'Container exited with code 125: invalid mount config',
    );
  });
});

describe('CONTAINER_IMAGE_UNAVAILABLE_USER_NOTICE（用户拍板 3a）', () => {
  test('说明原因、已跳过重试并给出处理建议', () => {
    expect(CONTAINER_IMAGE_UNAVAILABLE_USER_NOTICE).toContain('镜像');
    expect(CONTAINER_IMAGE_UNAVAILABLE_USER_NOTICE).toContain('已跳过自动重试');
    expect(CONTAINER_IMAGE_UNAVAILABLE_USER_NOTICE).toContain('拉取');
    expect(CONTAINER_IMAGE_UNAVAILABLE_USER_NOTICE).toContain('宿主机模式');
  });

  test('不暴露镜像名或 Docker 原文', () => {
    expect(CONTAINER_IMAGE_UNAVAILABLE_USER_NOTICE).not.toMatch(
      /ckq184|ckqclaw-agent|:latest|docker login|pull access/i,
    );
  });
});

describe('warnIfContainerImageMissing（用户拍板 4：启动期告警日志）', () => {
  test('镜像缺失时打 warn，含镜像名与处理建议，返回 false', async () => {
    const warn = vi.fn();
    const present = await warnIfContainerImageMissing({
      image: 'foo/bar:latest',
      getImageId: async () => null,
      warn,
    });
    expect(present).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const [obj, msg] = warn.mock.calls[0];
    expect(obj).toMatchObject({ image: 'foo/bar:latest' });
    expect(String(msg)).toMatch(/拉取|pull/i);
  });

  test('镜像存在时不告警，返回 true', async () => {
    const warn = vi.fn();
    const present = await warnIfContainerImageMissing({
      image: 'foo/bar:latest',
      getImageId: async () => 'sha256:abc',
      warn,
    });
    expect(present).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  test('查询抛错视为缺失并告警，不向上抛', async () => {
    const warn = vi.fn();
    await expect(
      warnIfContainerImageMissing({
        image: 'foo/bar:latest',
        getImageId: async () => {
          throw new Error('docker not found');
        },
        warn,
      }),
    ).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('退出错误接线（源码结构断言，风格同 provider-auth-error.test.ts）', () => {
  const read = (rel: string) =>
    fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

  test('Container closeCtx 注入 buildContainerExitError', () => {
    const runner = read('src/container-runner.ts');
    const anchor = runner.indexOf("filePrefix: 'container',");
    expect(anchor).toBeGreaterThan(-1);
    const ctx = runner.slice(anchor, runner.indexOf('};', anchor));
    expect(ctx).toContain('enrichError: buildContainerExitError');
  });

  test('退出错误串不再使用 stderr.slice(-200) 尾部截断', () => {
    expect(read('src/agent-output-parser.ts')).not.toMatch(
      /stderr\w*\.slice\(-200\)/,
    );
    expect(read('src/container-runner.ts')).not.toMatch(
      /stderr\w*\.slice\(-200\)/,
    );
  });
});
