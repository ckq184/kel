import type { RegisteredGroup } from './types.js';

export function clearTargetAgentBindingsForDeletedAgents(
  groups: Record<string, RegisteredGroup>,
  deletedAgentIds: ReadonlySet<string>,
  setGroup: (jid: string, group: RegisteredGroup) => void,
): number {
  let count = 0;
  if (deletedAgentIds.size === 0) return count;

  for (const [jid, group] of Object.entries(groups)) {
    if (!group.target_agent_id) continue;
    if (!deletedAgentIds.has(group.target_agent_id)) continue;

    setGroup(jid, { ...group, target_agent_id: undefined });
    count++;
  }

  return count;
}
