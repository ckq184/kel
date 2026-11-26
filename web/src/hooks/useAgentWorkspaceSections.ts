import { useMemo } from 'react';

import type { GroupInfo } from '../types';
import { type GroupEntry, compareByLastActivity } from '../utils/group-utils';
import {
  groupWorkspacesByAgent,
  partitionAgentWorkspaceSections,
} from '../utils/agent-product';

/**
 * THESIS-27 W3：桌面侧栏与移动端聊天页原先各自复制一份"按 Agent 分组
 * 工作区"的计算。排序（Home 最前、置顶优先）与分区规则只保留这一份。
 */
export function useAgentWorkspaceSections(groups: Record<string, GroupInfo>) {
  const allGroups = useMemo(() => {
    const entries: GroupEntry[] = Object.entries(groups).map(([jid, info]) => ({
      jid,
      ...info,
    }));
    entries.sort(compareByLastActivity);
    return entries;
  }, [groups]);

  const agentSections = useMemo(() => {
    const home = allGroups.find((entry) => entry.is_my_home);
    const defaultAgentId = home?.agent_profile_id || '__default__';
    const prioritized = [...allGroups].sort((a, b) => {
      if (a.is_my_home) return -1;
      if (b.is_my_home) return 1;
      return Number(!!b.pinned_at) - Number(!!a.pinned_at);
    });
    return groupWorkspacesByAgent(prioritized, defaultAgentId);
  }, [allGroups]);

  const agentPartitions = useMemo(
    () => partitionAgentWorkspaceSections(agentSections),
    [agentSections],
  );

  return { allGroups, agentSections, agentPartitions };
}
