import { beforeEach, describe, expect, test, vi } from 'vitest';

const sdkQuery = vi.fn();
vi.mock('../src/sdk-query.js', () => ({ sdkQuery }));
vi.mock('../src/runtime-config.js', () => ({
  getClaudeProviderConfig: vi.fn(() => ({
    anthropicBaseUrl: 'https://gateway.example.test',
    anthropicApiKey: 'configured',
  })),
}));

const { generateAgentProfileDraft, refineAgentProfilePrompt } =
  await import('../src/agent-profile-generator.js');
const runtimeConfig = await import('../src/runtime-config.js');

beforeEach(() => {
  sdkQuery.mockReset();
  vi.mocked(runtimeConfig.getClaudeProviderConfig).mockReturnValue({
    anthropicBaseUrl: 'https://gateway.example.test',
    anthropicApiKey: 'configured',
  } as ReturnType<typeof runtimeConfig.getClaudeProviderConfig>);
});

describe('AgentProfile AI generation', () => {
  test('official-only credentials without base URL reject before calling the model', async () => {
    vi.mocked(runtimeConfig.getClaudeProviderConfig).mockReturnValue({
      anthropicApiKey: 'sk-official',
      claudeCodeOauthToken: 'legacy-oauth-token',
      claudeOAuthCredentials: { accessToken: 'legacy-access' },
    } as unknown as ReturnType<typeof runtimeConfig.getClaudeProviderConfig>);

    await expect(generateAgentProfileDraft('review code')).rejects.toThrow(
      'Claude 提供商未配置',
    );
    expect(sdkQuery).not.toHaveBeenCalled();
  });

  test('empty configuration rejects before calling the model', async () => {
    vi.mocked(runtimeConfig.getClaudeProviderConfig).mockReturnValue(
      {} as ReturnType<typeof runtimeConfig.getClaudeProviderConfig>,
    );

    await expect(generateAgentProfileDraft('review code')).rejects.toThrow(
      'Claude 提供商未配置',
    );
    expect(sdkQuery).not.toHaveBeenCalled();
  });

  test('base URL + Auth Token is usable', async () => {
    vi.mocked(runtimeConfig.getClaudeProviderConfig).mockReturnValue({
      anthropicBaseUrl: 'https://gateway.example.test',
      anthropicAuthToken: 'gateway-token',
    } as ReturnType<typeof runtimeConfig.getClaudeProviderConfig>);
    sdkQuery.mockResolvedValueOnce(
      JSON.stringify({
        name: 'Auth Token Agent',
        identity_prompt: 'Reviewer',
        soul_prompt: '',
        agents_prompt: 'Review diffs',
        tools_prompt: '',
        prompt_mode: 'append',
      }),
    );

    await expect(
      generateAgentProfileDraft('review code'),
    ).resolves.toMatchObject({ name: 'Auth Token Agent' });
  });

  test('generates all four prompt sections', async () => {
    sdkQuery.mockResolvedValueOnce(
      JSON.stringify({
        name: 'Review Agent',
        identity_prompt: 'Reviewer',
        soul_prompt: 'Evidence first',
        agents_prompt: 'Review diffs',
        tools_prompt: 'Read before write',
        prompt_mode: 'append',
      }),
    );

    await expect(generateAgentProfileDraft('review code')).resolves.toEqual({
      name: 'Review Agent',
      identity_prompt: 'Reviewer',
      soul_prompt: 'Evidence first',
      agents_prompt: 'Review diffs',
      tools_prompt: 'Read before write',
      prompt_mode: 'append',
    });
  });

  test('refinement returns a complete candidate and preserves omitted sections', async () => {
    sdkQuery.mockResolvedValueOnce(
      JSON.stringify({
        reply: 'Updated tools',
        tools_prompt: 'Ask before destructive writes',
      }),
    );
    const currentPrompts = {
      identity_prompt: '\nReviewer\n',
      soul_prompt: 'Evidence first',
      agents_prompt: 'Review diffs',
      tools_prompt: 'Read before write',
      prompt_mode: 'append' as const,
    };

    await expect(
      refineAgentProfilePrompt({
        agentName: 'Review Agent',
        currentPrompts,
        section: 'tools',
        message: 'ask before dangerous changes',
        history: [],
      }),
    ).resolves.toEqual({
      reply: 'Updated tools',
      identity_prompt: '\nReviewer\n',
      soul_prompt: 'Evidence first',
      agents_prompt: 'Review diffs',
      tools_prompt: 'Ask before destructive writes',
    });
  });

  test('rejects an oversized generated section instead of silently truncating it', async () => {
    sdkQuery.mockResolvedValueOnce(
      JSON.stringify({
        name: 'Oversized Agent',
        identity_prompt: 'x'.repeat(20_001),
        soul_prompt: 'Evidence first',
        agents_prompt: 'Review diffs',
        tools_prompt: 'Read before write',
      }),
    );

    await expect(generateAgentProfileDraft('make it huge')).rejects.toThrow(
      '单段提示词超过 20000 字符限制',
    );
  });

  test('rejects a generated all-in-one IDENTITY without an AGENTS workflow', async () => {
    sdkQuery.mockResolvedValueOnce(
      JSON.stringify({
        name: 'Receipt Agent',
        identity_prompt:
          'Receipt assistant. Parse input, invoke scripts, retry failures, and send files.',
        soul_prompt: '',
        agents_prompt: '',
        tools_prompt: '',
        prompt_mode: 'append',
      }),
    );

    await expect(
      generateAgentProfileDraft('generate and send receipts'),
    ).rejects.toThrow('AI 生成的智能体配置格式无效');
  });
});
