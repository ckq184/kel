import { describe, expect, test, vi } from 'vitest';

import { clearTargetAgentBindingsForDeletedAgents } from '../src/im-context-isolation.js';
import type { RegisteredGroup } from '../src/types.js';

function makeGroup(
  name: string,
  overrides: Partial<RegisteredGroup> = {},
): RegisteredGroup {
  return {
    name,
    folder: 'home-u1',
    added_at: '2026-04-26T00:00:00.000Z',
    created_by: 'u1',
    ...overrides,
  };
}

describe('clearTargetAgentBindingsForDeletedAgents', () => {
  test('clears only target_agent_id bindings for agents deleted by workspace rebuild', () => {
    const groups: Record<string, RegisteredGroup> = {
      'feishu:auto': makeGroup('Auto', { target_agent_id: 'old-auto' }),
      'tg:manual': makeGroup('Manual', { target_agent_id: 'old-manual' }),
      'qq:survivor': makeGroup('Survivor', { target_agent_id: 'still-alive' }),
      'feishu:main': makeGroup('Main', { target_main_jid: 'web:home-u1' }),
    };
    const setGroup = vi.fn((jid: string, group: RegisteredGroup) => {
      groups[jid] = group;
    });

    const count = clearTargetAgentBindingsForDeletedAgents(
      groups,
      new Set(['old-auto', 'old-manual']),
      setGroup,
    );

    expect(count).toBe(2);
    expect(groups['feishu:auto'].target_agent_id).toBeUndefined();
    expect(groups['tg:manual'].target_agent_id).toBeUndefined();
    expect(groups['qq:survivor'].target_agent_id).toBe('still-alive');
    expect(groups['feishu:main'].target_main_jid).toBe('web:home-u1');
  });
});
