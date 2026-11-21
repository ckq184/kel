import { useMemo, useRef, useState } from 'react';
import {
  buildMcpPolicyOptions,
  normalizeMcpPolicyReferences,
} from '../utils/mcp-servers';
import {
  getAgentContextSource,
  type AgentContextSource,
  type AgentEffortLevel,
  type AgentProfileRuntimePolicy,
} from '../types';
import type { HostSkillSaveStatus } from '../components/agents/AgentSkillsPolicyEditor';
import {
  hostSkillPolicyForMode,
  skillSelectionError,
  type RuntimePolicyMode,
} from '../utils/agent-runtime-policy';
import { normalizeRuntimePolicy } from '../utils/agent-runtime-policy-form';
import { useSkillsStore } from '../stores/skills';
import { useMcpServersStore } from '../stores/mcp-servers';

// ISSUE-12 波 5 单元 5.3：AgentProfilesPage 的运行时策略状态簇（effort/
// contextSource/storedAutoCompact×2 含 ISSUE-04 透传注释/skills/host skills/
// mcp 三族状态与四个 ref）、applyRuntimePolicyToForm、能力错误与
// currentRuntimePolicy memos、技能/宿主技能/MCP 选项 memos 原文搬运
// （原页面 152/161-186/306-383/483-532 四段）。hook 内自读 skills/
// mcpServers 两 store（与页面读取同值）；搬运体逐字节一致；ISSUE-04
// 存量透传 state 刻意存续，不得当死代码清理。

export function useAgentRuntimePolicy() {
  const skills = useSkillsStore((state) => state.skills);
  const mcpServers = useMcpServersStore((state) => state.servers);

  const [effort, setEffort] = useState<AgentEffortLevel>('inherit');
  const [contextSource, setContextSource] =
    useState<AgentContextSource>('managed');
  // ISSUE-04 ⑤：自动压缩百分比/固定阈值旋钮已下线（Pi 运行时自主决定压缩
  // 时机）。存量策略值仅透传保存，不再提供编辑控件。
  const [storedAutoCompactWindow, setStoredAutoCompactWindow] = useState(0);
  const [storedAutoCompactPercentage, setStoredAutoCompactPercentage] =
    useState(0);
  const [skillsMode, setSkillsMode] = useState<RuntimePolicyMode>('inherit');
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [hostSkillsMode, setHostSkillsMode] =
    useState<RuntimePolicyMode>('disabled');
  const [hostSkillIds, setHostSkillIds] = useState<string[]>([]);
  const [hostSkillsSaving, setHostSkillsSaving] = useState(false);
  const [runtimeCleanupRepairing, setRuntimeCleanupRepairing] = useState(false);
  const [hostSkillsSaveStatus, setHostSkillsSaveStatus] =
    useState<HostSkillSaveStatus>('idle');
  const hostSkillsSavingRef = useRef(false);
  const selectedIdRef = useRef<string | null>(null);
  const confirmedHostSkillPolicyRef = useRef(
    hostSkillPolicyForMode('disabled', []),
  );
  const attemptedHostSkillPolicyRef = useRef(
    hostSkillPolicyForMode('disabled', []),
  );
  const [mcpMode, setMcpMode] = useState<RuntimePolicyMode>('inherit');
  const [mcpIds, setMcpIds] = useState<string[]>([]);

  const applyRuntimePolicyToForm = (
    policy?: AgentProfileRuntimePolicy | null,
  ) => {
    const normalized = normalizeRuntimePolicy(policy);
    setEffort(normalized.reasoning.effort);
    setSkillsMode(normalized.skills.mode);
    setSkillIds(normalized.skills.ids);
    const hostPolicy = normalized.skills.host ?? {
      mode: 'disabled' as const,
      ids: [],
    };
    setHostSkillsMode(hostPolicy.mode);
    setHostSkillIds(hostPolicy.ids);
    confirmedHostSkillPolicyRef.current = {
      mode: hostPolicy.mode,
      ids: [...hostPolicy.ids],
    };
    attemptedHostSkillPolicyRef.current = {
      mode: hostPolicy.mode,
      ids: [...hostPolicy.ids],
    };
    setHostSkillsSaveStatus('idle');
    setMcpMode(normalized.mcp.mode);
    setMcpIds(normalizeMcpPolicyReferences(normalized.mcp.ids));
    setContextSource(getAgentContextSource(normalized));
    setStoredAutoCompactWindow(normalized.context?.auto_compact_window ?? 0);
    setStoredAutoCompactPercentage(
      normalized.context?.auto_compact_percentage ?? 0,
    );
  };

  const managedSkillsError = useMemo(
    () =>
      skillSelectionError(' CKQClaw Skill', {
        mode: skillsMode,
        ids: skillIds,
      }),
    [skillIds, skillsMode],
  );
  const hostSkillsError = useMemo(
    () =>
      skillSelectionError('宿主机 Skill', {
        mode: hostSkillsMode,
        ids: hostSkillIds,
      }),
    [hostSkillIds, hostSkillsMode],
  );
  const capabilityError = managedSkillsError ?? hostSkillsError;

  const currentRuntimePolicy = useMemo(
    () =>
      normalizeRuntimePolicy({
        reasoning: { effort },
        context: {
          source: contextSource,
          auto_compact_window: storedAutoCompactWindow,
          auto_compact_percentage: storedAutoCompactPercentage,
        },
        skills: {
          mode: skillsMode,
          ids: skillIds,
          host: { mode: hostSkillsMode, ids: hostSkillIds },
        },
        mcp: { mode: mcpMode, ids: mcpIds },
      }),
    [
      contextSource,
      effort,
      hostSkillIds,
      hostSkillsMode,
      mcpIds,
      mcpMode,
      skillIds,
      skillsMode,
      storedAutoCompactPercentage,
      storedAutoCompactWindow,
    ],
  );

  const skillOptions = useMemo(() => {
    const available = skills
      .filter((skill) => skill.source === 'user' && skill.enabled)
      .map((skill) => ({
        id: skill.id,
        name: skill.name || skill.id,
        description: skill.description,
      }));
    const known = new Set(available.map((option) => option.id));
    return [
      ...available,
      ...skillIds
        .filter((id) => !known.has(id))
        .map((id) => ({ id, name: id, unavailable: true })),
    ];
  }, [skillIds, skills]);

  const hostSkillOptions = useMemo(() => {
    const available = skills
      .filter((skill) => skill.source === 'external' && skill.enabled)
      .map((skill) => ({
        id: skill.id,
        name: skill.name || skill.id,
        description: skill.description,
        sourceLabel: '宿主机',
      }));
    const known = new Set(available.map((option) => option.id));
    return [
      ...available,
      ...hostSkillIds
        .filter((id) => !known.has(id))
        .map((id) => ({
          id,
          name: id,
          sourceLabel: '宿主机',
          unavailable: true,
        })),
    ];
  }, [hostSkillIds, skills]);

  const mcpOptions = useMemo(() => {
    const available = buildMcpPolicyOptions(mcpServers);
    const known = new Set(available.map((option) => option.id));
    return [
      ...available,
      ...mcpIds
        .filter((id) => !known.has(id))
        .map((id) => ({ id, name: id, unavailable: true })),
    ];
  }, [mcpIds, mcpServers]);

  return {
    effort,
    setEffort,
    contextSource,
    setContextSource,
    storedAutoCompactWindow,
    setStoredAutoCompactWindow,
    storedAutoCompactPercentage,
    setStoredAutoCompactPercentage,
    skillsMode,
    setSkillsMode,
    skillIds,
    setSkillIds,
    hostSkillsMode,
    setHostSkillsMode,
    hostSkillIds,
    setHostSkillIds,
    hostSkillsSaving,
    setHostSkillsSaving,
    runtimeCleanupRepairing,
    setRuntimeCleanupRepairing,
    hostSkillsSaveStatus,
    setHostSkillsSaveStatus,
    hostSkillsSavingRef,
    selectedIdRef,
    confirmedHostSkillPolicyRef,
    attemptedHostSkillPolicyRef,
    mcpMode,
    setMcpMode,
    mcpIds,
    setMcpIds,
    applyRuntimePolicyToForm,
    managedSkillsError,
    hostSkillsError,
    capabilityError,
    currentRuntimePolicy,
    skillOptions,
    hostSkillOptions,
    mcpOptions,
  };
}
