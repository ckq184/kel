import type { ApiError } from '../api/client';
import { getAgentContextSource, type AgentEffortLevel } from '../types';
import {
  getHostSkillPolicy,
  hostSkillPolicyForMode,
} from './agent-runtime-policy';
import type { AgentProfileRuntimePolicy } from '../types';

// ISSUE-12 波 5 单元 5.3：AgentProfilesPage 的运行时策略纯函数与常量自
// web/src/pages/AgentProfilesPage.tsx 原文搬运（原 99-128/130-162/173-197
// 三段）。搬运体逐字节一致，仅 import 依新模块路径改写（类型与工具函数
// 均已在各源模块导出）。页面经同名 import 回接，全部调用点零改动。

export const DEFAULT_RUNTIME_POLICY: AgentProfileRuntimePolicy = {
  reasoning: { effort: 'inherit' },
  context: {
    source: 'managed',
    auto_compact_window: 0,
    auto_compact_percentage: 0,
  },
  skills: {
    mode: 'inherit',
    ids: [],
    host: { mode: 'disabled', ids: [] },
  },
  mcp: { mode: 'inherit', ids: [] },
};

export const AGENT_EFFORT_OPTIONS: Array<{
  value: AgentEffortLevel;
  label: string;
}> = [
  { value: 'inherit', label: '跟随模型配置' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
  { value: 'max', label: 'Max' },
];

export const AGENT_EFFORT_VALUES = new Set<AgentEffortLevel>(
  AGENT_EFFORT_OPTIONS.map((option) => option.value),
);

export function normalizeRuntimePolicy(
  policy?: Partial<AgentProfileRuntimePolicy> | null,
): AgentProfileRuntimePolicy {
  return {
    reasoning: {
      effort: AGENT_EFFORT_VALUES.has(
        policy?.reasoning?.effort as AgentEffortLevel,
      )
        ? (policy?.reasoning?.effort as AgentEffortLevel)
        : 'inherit',
    },
    context: {
      source: getAgentContextSource(policy),
      auto_compact_window:
        typeof policy?.context?.auto_compact_window === 'number'
          ? policy.context.auto_compact_window
          : 0,
      auto_compact_percentage:
        typeof policy?.context?.auto_compact_percentage === 'number'
          ? policy.context.auto_compact_percentage
          : 0,
    },
    skills: {
      mode: policy?.skills?.mode ?? 'inherit',
      ids: policy?.skills?.ids ?? [],
      host: getHostSkillPolicy(policy),
    },
    mcp: {
      mode: policy?.mcp?.mode ?? 'inherit',
      ids: policy?.mcp?.ids ?? [],
    },
  };
}

export function sameRuntimePolicy(
  a?: Partial<AgentProfileRuntimePolicy> | null,
  b?: Partial<AgentProfileRuntimePolicy> | null,
): boolean {
  return (
    JSON.stringify(normalizeRuntimePolicy(a)) ===
    JSON.stringify(normalizeRuntimePolicy(b))
  );
}

export function sameSkillSourcePolicy(
  a: ReturnType<typeof hostSkillPolicyForMode>,
  b: ReturnType<typeof hostSkillPolicyForMode>,
): boolean {
  return a.mode === b.mode && JSON.stringify(a.ids) === JSON.stringify(b.ids);
}

export function asApiError(error: unknown): ApiError | null {
  if (!error || typeof error !== 'object' || !('status' in error)) return null;
  const candidate = error as Partial<ApiError>;
  return typeof candidate.status === 'number' &&
    typeof candidate.message === 'string'
    ? (candidate as ApiError)
    : null;
}
