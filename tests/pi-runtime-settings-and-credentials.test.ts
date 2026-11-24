import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

import { resolveAgentThinkingLevel } from '../container/agent-runner/src/pi-settings.js';
import { resolvePiProvider } from '../container/agent-runner/src/runtime/pi/pi-provider.js';

/**
 * ISSUE-04 contract tests: the six host settings now have real Pi consumers.
 * ① context window declaration → Pi model contextWindow;
 * ③ effort → Pi thinkingLevel; ⑥ OAuth bearer tokens reach Pi via
 * ANTHROPIC_AUTH_TOKEN env discovery instead of being downgraded to
 * X-Api-Key via setRuntimeApiKey.
 *
 * The provider scenarios drive the real ModelRuntime on temp auth/models
 * stores, exactly like the production adapter does. All tokens are fake
 * fixtures; no real credentials, endpoints, or model endpoints are touched.
 */

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_OAUTH_TOKEN',
  'CLAUDE_CODE_EFFORT_LEVEL',
] as const;

const ORIGINAL_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    ORIGINAL_ENV[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
});

async function createModelRuntime(): Promise<ModelRuntime> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckqclaw-pi-settings-'));
  const authPath = path.join(dir, 'auth.json');
  const modelsPath = path.join(dir, 'models.json');
  fs.writeFileSync(authPath, '{}\n');
  fs.writeFileSync(modelsPath, '{}\n');
  return ModelRuntime.create({
    authPath,
    modelsPath,
    refreshOnCreate: false,
  });
}

describe('ISSUE-04 ① context window declaration reaches Pi', () => {
  test('custom endpoint registration honors the declared window', async () => {
    const modelRuntime = await createModelRuntime();
    const resolution = await resolvePiProvider(modelRuntime, {
      model: 'glm-5.2',
      endpointKind: 'custom',
      baseUrl: 'https://proxy.test',
      contextWindow: 1_000_000,
    });

    expect(resolution.model.contextWindow).toBe(1_000_000);
  });

  test('custom endpoint without a declaration keeps the 200K default', async () => {
    const modelRuntime = await createModelRuntime();
    const resolution = await resolvePiProvider(modelRuntime, {
      model: 'glm-5.2',
      endpointKind: 'custom',
      baseUrl: 'https://proxy.test',
    });

    expect(resolution.model.contextWindow).toBe(200_000);
  });

  test('official endpoints are rejected before model resolution (D-2 ②)', async () => {
    const modelRuntime = await createModelRuntime();

    await expect(
      resolvePiProvider(modelRuntime, {
        model: 'claude-haiku-4-5',
        endpointKind: 'official',
        contextWindow: 512_000,
      }),
    ).rejects.toThrow(/no longer supported/i);
  });

  test('custom endpoints without a base URL are rejected (D-2 ②)', async () => {
    const modelRuntime = await createModelRuntime();

    await expect(
      resolvePiProvider(modelRuntime, {
        model: 'glm-5.2',
        endpointKind: 'custom',
      }),
    ).rejects.toThrow(/ANTHROPIC_BASE_URL/);
  });
});

describe('ISSUE-04 ⑥ credential routing (bearer vs api key)', () => {
  test('official rejection never writes a runtime api key', async () => {
    const modelRuntime = await createModelRuntime();

    await expect(
      resolvePiProvider(modelRuntime, {
        model: 'claude-haiku-4-5',
        endpointKind: 'official',
        apiKey: 'fake-api-key-1',
      }),
    ).rejects.toThrow(/no longer supported/i);

    expect(await modelRuntime.getAuth('anthropic')).toBeUndefined();
  });

  test('custom endpoint keeps folding the bearer token into the registered key', async () => {
    const modelRuntime = await createModelRuntime();
    await resolvePiProvider(modelRuntime, {
      model: 'glm-5.2',
      endpointKind: 'custom',
      baseUrl: 'https://proxy.test',
      authToken: 'fake-bearer-3',
    });

    // 现状保留：custom 注册折入 apiKey（Bearer 代理语义不在本任务改动面）
    const auth = await modelRuntime.getAuth('ckqclaw-anthropic');
    expect(auth?.auth).toMatchObject({ apiKey: 'fake-bearer-3' });
  });
});

describe('ISSUE-04 ③ effort mapping to Pi thinkingLevel', () => {
  test('agent effort wins over the provider env default', () => {
    expect(resolveAgentThinkingLevel('high', 'max')).toBe('high');
  });

  test('provider env effort is the fallback when the agent inherits', () => {
    expect(resolveAgentThinkingLevel(undefined, 'low')).toBe('low');
  });

  test('no effort anywhere defers to the Pi default', () => {
    expect(resolveAgentThinkingLevel(undefined, undefined)).toBeUndefined();
    expect(resolveAgentThinkingLevel(undefined, '')).toBeUndefined();
  });

  test('the host never sends inherit, but it must stay inert if it does', () => {
    expect(resolveAgentThinkingLevel('inherit', 'max')).toBe('max');
  });

  test('garbage values are ignored instead of forwarded to Pi', () => {
    expect(resolveAgentThinkingLevel(undefined, 'garbage')).toBeUndefined();
    expect(resolveAgentThinkingLevel(undefined, 'off')).toBeUndefined();
    // Agent 级垃圾值视为未设置：回退 provider env，而不是原样上送
    expect(resolveAgentThinkingLevel('not-a-level' as never, 'max')).toBe(
      'max',
    );
  });
});

describe('ISSUE-04 production wiring source contracts', () => {
  const runnerRoot = path.resolve('container/agent-runner/src');

  test('pi-index wires window, effort, and split credentials into sessionOptions', () => {
    const source = fs.readFileSync(
      path.join(runnerRoot, 'pi-index.ts'),
      'utf8',
    );

    expect(source).toMatch(/resolveContextWindowOverride\(/);
    expect(source).toMatch(/contextWindow:\s*resolveContextWindowOverride/);
    expect(source).toMatch(/resolveAgentThinkingLevel\(/);
    expect(source).toMatch(/thinkingLevel:\s*resolveAgentThinkingLevel/);
    // ⑥ 折旧断链：Bearer 不得再被折进 apiKey（降级 X-Api-Key 的老 bug）
    expect(source).not.toMatch(
      /ANTHROPIC_API_KEY\s*\|\|\s*process\.env\.ANTHROPIC_AUTH_TOKEN/,
    );
    expect(source).toMatch(/authToken:\s*process\.env\.ANTHROPIC_AUTH_TOKEN/);
  });

  test('ContainerInput agentProfile carries the resolved effort field', () => {
    const source = fs.readFileSync(path.join(runnerRoot, 'types.ts'), 'utf8');

    expect(source).toMatch(
      /effort\?:\s*'low'\s*\|\s*'medium'\s*\|\s*'high'\s*\|\s*'xhigh'\s*\|\s*'max'/,
    );
  });

  test('the runtime adapter forwards authToken and contextWindow (①⑥ middle hop)', () => {
    // 审查阻塞修复：适配层是 sessionOptions 与 provider 解析之间的唯一一跳，
    // 两端各自有测试时仍可能在此断链——本契约锁中段转发。
    const piRuntime = fs.readFileSync(
      path.join(runnerRoot, 'runtime/pi/pi-runtime.ts'),
      'utf8',
    );

    expect(piRuntime).toMatch(/authToken:\s*options\.provider\?\.authToken/);
    expect(piRuntime).toMatch(
      /contextWindow:\s*options\.provider\?\.contextWindow/,
    );
  });

  test('retired dead resolvers stay deleted (⑤ auto-compact, ① query runtime)', () => {
    const contextWindowSource = fs.readFileSync(
      path.join(runnerRoot, 'context-window.ts'),
      'utf8',
    );
    expect(contextWindowSource).not.toMatch(
      /resolveAutoCompactWindow|resolveLegacyAutoCompactWindow/,
    );

    const providerRuntimeSource = fs.readFileSync(
      path.join(runnerRoot, 'provider-runtime.ts'),
      'utf8',
    );
    expect(providerRuntimeSource).not.toMatch(/resolveClaudeQueryModelRuntime/);
  });
});

describe('ISSUE-04 host wiring source contracts', () => {
  const hostRoot = path.resolve('src');
  const readSource = (rel: string): string =>
    fs.readFileSync(path.join(hostRoot, rel), 'utf8').replace(/\r\n/g, '\n');

  test('both agent-profile funnels resolve and send the effort field (③)', () => {
    const main = readSource('index.ts');
    const taskScheduler = readSource('task-scheduler.ts');

    expect(main).toMatch(/effort:\s*resolveAgentSdkEffort\(/);
    expect(taskScheduler).toMatch(/effort:\s*resolveAgentSdkEffort\(/);
  });

  test('host ContainerInput mirror declares the effort field (③)', () => {
    const containerRunner = readSource('container-runner.ts');

    // 宿主侧复用 agent-effort 的 SDK 级别别名（runner 侧因跨项目才内联联合）
    expect(containerRunner).toMatch(/effort\?:\s*SdkAgentEffort/);
  });

  test('fallback model injection is fully removed (②)', () => {
    const containerRunner = readSource('container-runner.ts');

    expect(containerRunner).not.toMatch(
      /applyFallbackModelToEnvLines|CKQCLAW_FALLBACK_MODEL/,
    );
  });

  test('agent auto-compact env chain is fully retired (⑤ + ISSUE-10 ⑥)', () => {
    const containerRunner = readSource('container-runner.ts');

    // 注入彻底移除：不再有 push / hostEnv 赋值 / 本地取值函数
    expect(containerRunner).not.toMatch(/getAgentAutoCompact/);
    expect(containerRunner).not.toMatch(
      /envLines\.push\(`AUTO_COMPACT_(PERCENTAGE|WINDOW)=/,
    );
    expect(containerRunner).not.toMatch(
      /hostEnv\['AUTO_COMPACT_(PERCENTAGE|WINDOW)'\]\s*=/,
    );
    // ISSUE-10 ⑥：CLAUDE_CODE_AUTO_COMPACT_WINDOW 注入也一并下线（Pi 窗口
    // 走 CKQCLAW_CONTEXT_WINDOW，Bash 内 claude CLI 不再继承窗口控制），
    // 继承值剥离随之整体消失——runner 侧对 AUTO_COMPACT_* 键再无任何引用。
    expect(containerRunner).not.toMatch(/AUTO_COMPACT_WINDOW/);
    expect(containerRunner).not.toMatch(/AUTO_COMPACT_PERCENTAGE/);
    expect(containerRunner).not.toMatch(
      /envLines\.push\(`CKQCLAW_AGENT_MCP_POLICY=/,
    );
    expect(containerRunner).not.toMatch(/CKQCLAW_AGENT_TOOL_POLICY/);
    expect(containerRunner).not.toMatch(/CKQCLAW_AGENT_DISALLOWED_TOOLS/);
  });
});

describe('ISSUE-04 web UI source contracts', () => {
  const webRoot = path.resolve('web/src');
  const readSource = (rel: string): string =>
    fs.readFileSync(path.join(webRoot, rel), 'utf8').replace(/\r\n/g, '\n');

  test('the quota-wall fallback model control is gone (②)', () => {
    const systemSettings = readSource(
      'components/settings/SystemSettingsSection.tsx',
    );

    expect(systemSettings).not.toMatch(
      /fallbackModel|额度墙回退模型|CKQCLAW_FALLBACK_MODEL/,
    );
  });

  test('auto-compact override controls are downlined with honest annotations (⑤)', () => {
    const systemSettings = readSource(
      'components/settings/SystemSettingsSection.tsx',
    );
    const profilesPage = readSource('pages/AgentProfilesPage.tsx');

    // 覆盖编辑控件（含 legacy 阈值迁移按钮）不再提供
    expect(systemSettings).not.toMatch(
      /id="main-agent-auto-compact-(default|percentage)"/,
    );
    expect(profilesPage).not.toMatch(
      /id="agent-auto-compact-(default|percentage)"/,
    );
    expect(profilesPage).not.toMatch(
      /setUseSdkCompactDefault|autoCompactPercentage === 'legacy'/,
    );
    // 如实注记保留：运行时自主决定 + 旋钮下线说明
    expect(systemSettings).toMatch(
      /历史百分比与固定阈值配置已于 Pi 运行时下线/,
    );
    // ISSUE-12 波 5 单元 5.8：SDK 自动压缩说明已随能力配置区迁
    // web/src/components/agents/AgentCapabilitiesSection.tsx（原文搬运），
    // 锚随体迁、断言语义不变。
    const capabilitiesSection = fs.readFileSync(
      path.join(
        process.cwd(),
        'web/src/components/agents/AgentCapabilitiesSection.tsx',
      ),
      'utf8',
    );
    expect(capabilitiesSection).toMatch(
      // ISSUE-12 波 5 单元 5.8 留痕：prettier 对组件内 JSX 说明文字重排，
      // 「Pi」与「运行时下线」间断行，该一处字面空格改 \s+（与同句既有
      // \s* 边界风格一致，断言语义不弱化）。
      /历史百分比与\s*固定阈值配置已于 Pi\s+运行时下线/,
    );
  });

  test('prompt-mode toggle is replaced by an honest composition note (④)', () => {
    const promptEditor = readSource('components/agents/AgentPromptEditor.tsx');
    const profilesPage = readSource('pages/AgentProfilesPage.tsx');

    // 负向断言只针对交互控件与回调；注记文字里合法提及「Claude Code
    // 默认提示词已消失」是如实说明，不属于残留
    expect(promptEditor).not.toMatch(/PromptModeOption|onModeChange/);
    expect(promptEditor).toMatch(/系统提示词构成/);
    expect(promptEditor).toMatch(/两种模式产物一致，故不再提供切换/);
    // 父组件接线同步清理（含 draft 确认页的「Claude 默认提示词」SummaryItem）
    expect(profilesPage).not.toMatch(/onModeChange=\{setPromptMode\}/);
    expect(profilesPage).not.toMatch(/Claude 默认提示词/);
    // API 兼容锁定：存量 prompt_mode 仍随创建/保存提交，不做破坏性删除
    expect(profilesPage).toMatch(/prompt_mode: promptMode/);
    expect(profilesPage).toMatch(
      /buildAgentPromptPatch\(currentPrompts, promptMode/,
    );
  });

  test('official auth tabs carry the Pi bearer note (⑥)', () => {
    const providerEditor = readSource('components/settings/ProviderEditor.tsx');

    expect(providerEditor).toMatch(/以 Bearer Token\s*方式对官方端点生效/);
    expect(providerEditor).toMatch(/不会自动刷新/);
  });
});
