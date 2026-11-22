import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  classifyRunContextSnapshot,
  getRunContextSnapshot,
  recordRunContextSnapshot,
  type ClaudeContextAudit,
} from '../src/run-context-snapshot.js';
import { buildClaudeEnvLines } from '../src/runtime-config.js';

/**
 * ISSUE-10 拍板⑤（ISSUE-07 方向落地）：宿主直接记录运行上下文审计快照，
 * 取代经 context_audit 事件 / stdin 死字段的传输。本契约锁定：
 * ① 快照键语义（agent-profiles 预览按 'main' 键读）；② classify 对
 * skills/mcp/agentProfile hash 的比对口径；③ ANTHROPIC_API_KEY 进入
 * RESERVED_CLAUDE_ENV_KEYS（ISSUE-04 遗留，随本批拍板⑦顺带修复）。
 */

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

function minimalAudit(
  overrides: Partial<ClaudeContextAudit> = {},
): ClaudeContextAudit {
  return {
    executionMode: 'host',
    claudeMd: { status: 'linked', loaded: true },
    rules: { fileCount: 0, status: 'linked' },
    skills: { manifestHash: 'skills-hash', sources: [] },
    ckqclawPrompt: { totalBytes: 0, files: [] },
    warnings: [],
    ...overrides,
  };
}

describe('run context snapshot host wiring (ISSUE-10 ⑤)', () => {
  test("preview reads the 'main' key, so main-session recording aligns", () => {
    // agent-profiles.ts 的预览调用 getRunContextSnapshot(workspace.jid)
    // 不传 agentId —— 落 'main' 键。container-runner 的主会话路径
    // recordRunContextSnapshot 同样不传 agentId，两侧键天然对齐。
    recordRunContextSnapshot({
      chatJid: 'web:preview-workspace',
      audit: minimalAudit(),
    });
    expect(getRunContextSnapshot('web:preview-workspace')).not.toBeNull();
    expect(
      getRunContextSnapshot('web:preview-workspace', 'some-agent'),
    ).toBeNull();

    const profilesRoute = read('src/routes/agent-profiles.ts');
    expect(profilesRoute).toContain('getRunContextSnapshot(workspace.jid)');
  });

  test('both host paths fill audit.agentProfile from the DB profile (质量轮 Major②)', () => {
    // classify 的首道门是 agentProfile 比对；接线点若不填，预览恒判
    // stale_profile。两路径（容器/宿主机）record 前都须从 DB 档案补齐
    // id/version/identityHash/runtimePolicyHash。
    const containerRunner = read('src/container-runner.ts');
    expect(containerRunner).toMatch(
      /import \{[^}]*hashRuntimePolicy[^}]*recordRunContextSnapshot[^}]*\} from '\.\/run-context-snapshot\.js';/,
    );
    expect(
      containerRunner.match(
        /audit\.agentProfile = profileRow[\s\S]{0,200}identityHash: profileRow\.identity_hash,/g,
      ),
    ).toHaveLength(2);
  });

  test('classify compares the same hashes the host audit carries', () => {
    recordRunContextSnapshot({
      chatJid: 'web:classify-workspace',
      agentId: 'agent-1',
      audit: minimalAudit({
        agentProfile: {
          id: 'agent-1',
          version: 3,
          identityHash: 'identity-a',
          runtimePolicyHash: 'policy-a',
        },
        mcp: { manifestHash: 'mcp-a', serverIds: ['srv-1'] },
      }),
    });
    const snapshot = getRunContextSnapshot('web:classify-workspace', 'agent-1');
    expect(snapshot).not.toBeNull();

    expect(
      classifyRunContextSnapshot(snapshot, {
        agentProfile: {
          id: 'agent-1',
          version: 3,
          identityHash: 'identity-a',
          runtimePolicyHash: 'policy-a',
        },
        skillManifestHash: 'skills-hash',
        mcpManifestHash: 'mcp-a',
      }),
    ).toBe('current');

    expect(
      classifyRunContextSnapshot(snapshot, {
        agentProfile: {
          id: 'agent-1',
          version: 3,
          identityHash: 'identity-a',
          runtimePolicyHash: 'policy-b',
        },
        skillManifestHash: 'skills-hash',
        mcpManifestHash: 'mcp-a',
      }),
    ).toBe('stale_config');
  });

  test('host audit without sdkContextUsage keeps budget unavailable, not fake', () => {
    recordRunContextSnapshot({
      chatJid: 'web:budget-workspace',
      audit: minimalAudit(),
    });
    const snapshot = getRunContextSnapshot('web:budget-workspace');
    expect(snapshot?.sdkContext).toBeNull();
    expect(snapshot?.budget).toBeNull();
  });
});

describe('reserved claude env keys (ISSUE-10 ⑦)', () => {
  test('custom env cannot override the provider ANTHROPIC_API_KEY line', () => {
    // ANTHROPIC_API_KEY 由 provider 配置行权威写入；custom env 追加不得覆盖。
    const lines = buildClaudeEnvLines(
      {
        anthropicBaseUrl: 'https://third-party.example',
        anthropicModel: 'glm-5.2',
        anthropicApiKey: 'provider-key',
      },
      { ANTHROPIC_API_KEY: 'attacker-key' },
    );
    expect(lines).toContain('ANTHROPIC_API_KEY=provider-key');
    expect(lines).not.toContain('ANTHROPIC_API_KEY=attacker-key');
  });
});
