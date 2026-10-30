import { describe, expect, test } from 'vitest';
import { buildCkqclawPromptPlan } from '../container/agent-runner/src/prompt-plan.js';

describe('agent-runner system prompt composition order', () => {
  test('Agent identity leads platform workspace/context material', () => {
    const plan = buildCkqclawPromptPlan({
      platformIdentity: 'CKQClaw',
      platformBootstrap: 'first wake',
      agentIdentity: 'identity',
      interaction: 'interaction',
      security: 'security',
      output: 'output',
    });
    expect(plan.blocks.map((block) => block.id)).toEqual([
      'identity.ckqclaw',
      'bootstrap.ckqclaw',
      'agent-profile',
      'interaction',
      'security-rules',
      'output',
    ]);
  });
});
