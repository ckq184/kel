import { describe, expect, test } from 'vitest';

import {
  buildClaudeEnvLines,
  buildContainerEnvLines,
  clearInheritedClaudeProviderEnv,
  type ClaudeProviderConfig,
} from '../src/runtime-config.js';

function config(patch: Partial<ClaudeProviderConfig>): ClaudeProviderConfig {
  return {
    anthropicBaseUrl: 'https://example.test/anthropic',
    anthropicAuthToken: '',
    anthropicApiKey: '',
    claudeCodeOauthToken: '',
    claudeOAuthCredentials: null,
    anthropicModel: 'test-model',
    updatedAt: null,
    ...patch,
  };
}

// Always pass an explicit (empty) profileCustomEnv so buildClaudeEnvLines does
// NOT fall through to getActiveProfileCustomEnv() → readStoredStateV4(), which
// reads (and may lazily migrate-write) the real on-disk claude-provider.json.
// Keeping the test hermetic avoids leaking ambient config and disk mutation.
const NO_CUSTOM_ENV: Record<string, string> = {};

describe('buildClaudeEnvLines', () => {
  test('maps plain third-party auth tokens to ANTHROPIC_API_KEY', () => {
    const lines = buildClaudeEnvLines(
      config({ anthropicAuthToken: 'plain-token' }),
      NO_CUSTOM_ENV,
    );

    expect(lines).toContain('ANTHROPIC_API_KEY=plain-token');
    expect(lines).not.toContain('ANTHROPIC_AUTH_TOKEN=plain-token');
  });

  test('routes explicit Bearer tokens to ANTHROPIC_AUTH_TOKEN without doubling the prefix', () => {
    const lines = buildClaudeEnvLines(
      config({ anthropicAuthToken: 'Bearer upstream-token' }),
      NO_CUSTOM_ENV,
    );

    // The SDK emits `Authorization: Bearer <value>` itself, so the stored value
    // must be the bare token — otherwise the header becomes `Bearer Bearer …`.
    expect(lines).toContain('ANTHROPIC_AUTH_TOKEN=upstream-token');
    expect(lines).not.toContain('ANTHROPIC_AUTH_TOKEN=Bearer upstream-token');
    expect(lines).not.toContain('ANTHROPIC_API_KEY=upstream-token');
  });

  test('preserves newlines in ANTHROPIC_CUSTOM_HEADERS', () => {
    const lines = buildClaudeEnvLines(config({}), {
      ANTHROPIC_CUSTOM_HEADERS: 'x-one: 1\nx-two: 2',
    });

    expect(lines).toContain('ANTHROPIC_CUSTOM_HEADERS=x-one: 1\nx-two: 2');
  });

  test('derives managed Claude Code defaults for third-party models', () => {
    const lines = buildClaudeEnvLines(
      config({ anthropicModel: 'glm-5.2[1m]' }),
      NO_CUSTOM_ENV,
    );

    // 任务AL：后缀剥离后再上送（根治第三方端点 400），窗口经声明 env 按 1M 认定
    expect(lines).toContain('ANTHROPIC_MODEL=glm-5.2');
    expect(lines).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.2');
    expect(lines).toContain('ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.2');
    expect(lines).toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-5.2');
    expect(lines).toContain('CKQCLAW_CONTEXT_WINDOW=1000000');
    // ISSUE-10 ⑥：AUTO_COMPACT 窗口注入整体下线，env 行不得再出现该键。
    expect(
      lines.some((line) => line.startsWith('CLAUDE_CODE_AUTO_COMPACT_WINDOW=')),
    ).toBe(false);
    expect(lines).toContain('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1');
    expect(lines).toContain('CLAUDE_CODE_EFFORT_LEVEL=max');
    expect(lines).toContain('CLAUDE_CODE_NO_FLICKER=1');
    expect(lines).toContain('API_TIMEOUT_MS=3000000');
  });

  test('declared context window injects without any model suffix', () => {
    const lines = buildClaudeEnvLines(
      config({ anthropicModel: 'glm-5.2', contextWindow: 512_000 }),
      NO_CUSTOM_ENV,
    );

    expect(lines).toContain('ANTHROPIC_MODEL=glm-5.2');
    expect(lines).toContain('CKQCLAW_CONTEXT_WINDOW=512000');
    // ISSUE-10 ⑥：AUTO_COMPACT 窗口注入整体下线，env 行不得再出现该键。
    expect(
      lines.some((line) => line.startsWith('CLAUDE_CODE_AUTO_COMPACT_WINDOW=')),
    ).toBe(false);
  });

  test('declared window wins over a legacy [1m] suffix', () => {
    const lines = buildClaudeEnvLines(
      config({ anthropicModel: 'glm-5.2[1m]', contextWindow: 256_000 }),
      NO_CUSTOM_ENV,
    );

    expect(lines).toContain('ANTHROPIC_MODEL=glm-5.2');
    expect(lines).toContain('CKQCLAW_CONTEXT_WINDOW=256000');
    // ISSUE-10 ⑥：AUTO_COMPACT 窗口注入整体下线，env 行不得再出现该键。
    expect(
      lines.some((line) => line.startsWith('CLAUDE_CODE_AUTO_COMPACT_WINDOW=')),
    ).toBe(false);
  });

  test('no declaration and no suffix stays byte-equivalent with today', () => {
    const lines = buildClaudeEnvLines(
      config({ anthropicModel: 'glm-5.2' }),
      NO_CUSTOM_ENV,
    );

    expect(lines).toContain('ANTHROPIC_MODEL=glm-5.2');
    expect(
      lines.some((line) => line.startsWith('CKQCLAW_CONTEXT_WINDOW=')),
    ).toBe(false);
    // ISSUE-10 ⑥：AUTO_COMPACT 窗口注入整体下线，env 行不得再出现该键。
    expect(
      lines.some((line) => line.startsWith('CLAUDE_CODE_AUTO_COMPACT_WINDOW=')),
    ).toBe(false);
  });

  test("explicit 'auto' declaration behaves like no declaration", () => {
    const lines = buildClaudeEnvLines(
      config({ anthropicModel: 'glm-5.2[1m]', contextWindow: 'auto' }),
      NO_CUSTOM_ENV,
    );

    // auto = 现行为：启发式因后缀按 1M 认定，模型名仍剥离
    expect(lines).toContain('ANTHROPIC_MODEL=glm-5.2');
    expect(lines).toContain('CKQCLAW_CONTEXT_WINDOW=1000000');
    // ISSUE-10 ⑥：AUTO_COMPACT 窗口注入整体下线，env 行不得再出现该键。
    expect(
      lines.some((line) => line.startsWith('CLAUDE_CODE_AUTO_COMPACT_WINDOW=')),
    ).toBe(false);
  });

  test('uses defaults but lets provider settings override third-party values', () => {
    // ISSUE-10 ⑥：CLAUDE_CODE_AUTO_COMPACT_WINDOW 不再是平台托管键，
    // 平台既不注入也不管理它，测试夹具随之移除。
    const lines = buildClaudeEnvLines(config({ anthropicModel: 'k3' }), {
      CLAUDE_CODE_EFFORT_LEVEL: 'low',
      CUSTOM_FLAG: 'kept',
    });

    expect(lines).toContain('CLAUDE_CODE_EFFORT_LEVEL=low');
    expect(lines).not.toContain('CLAUDE_CODE_EFFORT_LEVEL=max');
    expect(lines).toContain('CUSTOM_FLAG=kept');
  });

  test('keeps runtime tuning customizable for third-party providers', () => {
    const lines = buildClaudeEnvLines(config({ anthropicModel: 'glm-5.2' }), {
      CLAUDE_CODE_EFFORT_LEVEL: 'low',
    });

    expect(lines).toContain('CLAUDE_CODE_EFFORT_LEVEL=low');
    expect(lines).not.toContain('CLAUDE_CODE_EFFORT_LEVEL=max');
  });

  test('prevents workspace overrides from replacing third-party managed values', () => {
    const lines = buildContainerEnvLines(
      config({ anthropicModel: 'glm-5.2[1m]' }),
      {
        customEnv: {
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'stale-model',
          CKQCLAW_FALLBACK_MODEL: 'workspace-fallback',
          PROJECT_ENV: 'kept',
        },
      },
      NO_CUSTOM_ENV,
    );

    expect(lines).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.2');
    expect(lines).toContain('CKQCLAW_CONTEXT_WINDOW=1000000');
    expect(lines).not.toContain('ANTHROPIC_DEFAULT_OPUS_MODEL=stale-model');
    expect(lines).not.toContain('CKQCLAW_FALLBACK_MODEL=workspace-fallback');
    expect(lines).toContain('PROJECT_ENV=kept');
  });

  test('blocks legacy internal workspace path variables from custom env', () => {
    const lines = buildContainerEnvLines(
      config({ anthropicBaseUrl: '', anthropicModel: '' }),
      {
        customEnv: {
          CKQCLAW_WORKSPACE_GLOBAL: '/attacker/global',
          CKQCLAW_WORKSPACE_MEMORY: '/attacker/memory',
          PROJECT_ENV: 'kept',
        },
      },
      NO_CUSTOM_ENV,
    );

    expect(lines).not.toContain('CKQCLAW_WORKSPACE_GLOBAL=/attacker/global');
    expect(lines).not.toContain('CKQCLAW_WORKSPACE_MEMORY=/attacker/memory');
    expect(lines).toContain('PROJECT_ENV=kept');
  });

  test('blocks container identity and session permission control variables', () => {
    const blocked = {
      CKQCLAW_HOST_IDENTITY_MODE: 'direct',
      CKQCLAW_HOST_UID: '0',
      CKQCLAW_HOST_GID: '0',
      CKQCLAW_INTERNAL_IDENTITY_MODE: 'direct',
      CKQCLAW_INTERNAL_FUTURE_ROOT_KNOB: '/workspace/group/evil',
      CKQCLAW_PASSWD_FILE: '/workspace/group/passwd',
      CKQCLAW_RECONCILE_SESSION_PERMISSIONS: '1',
      CKQCLAW_MOUNT_PREPARE_MODE: 'recursive',
      CKQCLAW_RUNTIME_USER: 'root',
      CKQCLAW_SESSION_ROOT: '/',
      CKQCLAW_SESSION_PERMISSION_PID: '1',
      CKQCLAW_SESSION_PERMISSION_HELPER: '/workspace/group/evil.sh',
      PATH: '/workspace/group/bin',
      NODE_OPTIONS: '--require=/workspace/group/evil.js',
      LD_PRELOAD: '/workspace/group/evil.so',
      BASH_ENV: '/workspace/group/evil.sh',
    };
    const lines = buildContainerEnvLines(
      config({ anthropicBaseUrl: '', anthropicModel: '' }),
      { customEnv: { ...blocked, PROJECT_ENV: 'kept' } },
      blocked,
    );

    for (const key of Object.keys(blocked)) {
      expect(lines.some((line) => line.startsWith(`${key}=`))).toBe(false);
    }
    expect(lines).toContain('PROJECT_ENV=kept');
  });

  test('injects an authoritative endpoint kind that custom env cannot replace', () => {
    const thirdParty = buildContainerEnvLines(
      config({ anthropicBaseUrl: 'https://proxy.test' }),
      { customEnv: { CKQCLAW_CLAUDE_ENDPOINT_KIND: 'official' } },
      { CKQCLAW_CLAUDE_ENDPOINT_KIND: 'official' },
    );
    const unconfigured = buildContainerEnvLines(
      config({ anthropicBaseUrl: '', anthropicModel: '' }),
      {},
      NO_CUSTOM_ENV,
    );

    expect(thirdParty).toContain('CKQCLAW_CLAUDE_ENDPOINT_KIND=custom');
    expect(thirdParty).not.toContain('CKQCLAW_CLAUDE_ENDPOINT_KIND=official');
    // D-2 ②：没有 Base URL 时不再声明官方端点——运行时会直接拒绝该配置。
    expect(
      unconfigured.some((line) =>
        line.startsWith('CKQCLAW_CLAUDE_ENDPOINT_KIND='),
      ),
    ).toBe(false);
  });

  test('custom env cannot spoof the managed context window declaration', () => {
    const lines = buildContainerEnvLines(
      config({ anthropicModel: 'glm-5.2', contextWindow: 256_000 }),
      {
        customEnv: {
          CKQCLAW_CONTEXT_WINDOW: '1000000',
          PROJECT_ENV: 'kept',
        },
      },
      { CKQCLAW_CONTEXT_WINDOW: '1000000' },
    );

    expect(lines).toContain('CKQCLAW_CONTEXT_WINDOW=256000');
    expect(
      lines.filter((l) => l.startsWith('CKQCLAW_CONTEXT_WINDOW=')).length,
    ).toBe(1);
    expect(lines).toContain('PROJECT_ENV=kept');
  });

  test('clears inherited provider values before host-mode config is applied', () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_BASE_URL: 'https://stale-proxy.test',
      ANTHROPIC_AUTH_TOKEN: 'stale-token',
      ANTHROPIC_API_KEY: 'stale-key',
      ANTHROPIC_MODEL: 'stale-model',
      ANTHROPIC_CUSTOM_HEADERS: 'x-stale-auth: yes',
      CKQCLAW_CLAUDE_ENDPOINT_KIND: 'custom',
      CKQCLAW_CONTEXT_WINDOW: '1000000',
      KEEP_ME: 'yes',
    };

    clearInheritedClaudeProviderEnv(env);

    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(env.CKQCLAW_CLAUDE_ENDPOINT_KIND).toBeUndefined();
    expect(env.CKQCLAW_CONTEXT_WINDOW).toBeUndefined();
    expect(env.KEEP_ME).toBe('yes');

    const selectedProviderLines = buildContainerEnvLines(
      config({ anthropicBaseUrl: '', anthropicModel: '' }),
      {},
      { ANTHROPIC_CUSTOM_HEADERS: 'x-current-provider: yes' },
    );
    for (const line of selectedProviderLines) {
      const separator = line.indexOf('=');
      env[line.slice(0, separator)] = line.slice(separator + 1);
    }
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('x-current-provider: yes');
  });
});
