import { useEffect, useMemo, useState } from 'react';
import { useAgentProfilesStore } from '../stores/agent-profiles';
import type {
  AgentProfilePromptMode,
  AgentProfileRuntimePolicy,
} from '../types';
import type {
  AgentPromptParts,
  AgentPromptSection,
} from '../utils/agent-prompts';
import {
  DEFAULT_RUNTIME_POLICY,
  sameRuntimePolicy,
} from '../utils/agent-runtime-policy-form';

// ISSUE-12 波 5 单元 5.4：AgentProfilesPage 的表单状态簇（name/identity/
// soul/agents/tools 四段提示词/promptMode/modelConfigId/assistantSection/
// 头像四态）、currentPrompts/setCurrentPrompts、选中档案回填效应与
// dirty/draftDirty 计算原文搬运（原页面 128-142/159-173/301-334/343-369
// 四段）。计划红线严格落实：回填效应依赖数组刻意只含
// [draftMode, selected?.id]，逐字保留不补全（applyRuntimePolicyToForm 与
// setCurrentPrompts 均为渲染期稳定引用语义，补全即行为变更）。
// applyRuntimePolicyToForm/currentRuntimePolicy 归 useAgentRuntimePolicy
// 所有（5.3b），经 input 注入。搬运体逐字节一致。

type AgentProfileRow = ReturnType<
  typeof useAgentProfilesStore.getState
>['profiles'][number];

export interface UseAgentProfileFormInput {
  selected: AgentProfileRow | null;
  draftMode: boolean;
  applyRuntimePolicyToForm: (policy?: AgentProfileRuntimePolicy | null) => void;
  currentRuntimePolicy: AgentProfileRuntimePolicy;
}

export function useAgentProfileForm(input: UseAgentProfileFormInput) {
  const {
    selected,
    draftMode,
    applyRuntimePolicyToForm,
    currentRuntimePolicy,
  } = input;

  const [name, setName] = useState('');
  const [identityPrompt, setIdentityPrompt] = useState('');
  const [soulPrompt, setSoulPrompt] = useState('');
  const [agentsPrompt, setAgentsPrompt] = useState('');
  const [toolsPrompt, setToolsPrompt] = useState('');
  const [promptMode, setPromptMode] =
    useState<AgentProfilePromptMode>('append');
  const [modelConfigId, setModelConfigId] = useState('inherit');
  const [assistantSection, setAssistantSection] =
    useState<AgentPromptSection>('identity');
  const [avatarEmoji, setAvatarEmoji] = useState<string | null>(null);
  const [avatarColor, setAvatarColor] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [avatarStyleOpen, setAvatarStyleOpen] = useState(false);

  const currentPrompts = useMemo<AgentPromptParts>(
    () => ({
      identity_prompt: identityPrompt,
      soul_prompt: soulPrompt,
      agents_prompt: agentsPrompt,
      tools_prompt: toolsPrompt,
    }),
    [agentsPrompt, identityPrompt, soulPrompt, toolsPrompt],
  );
  const setCurrentPrompts = (next: AgentPromptParts) => {
    setIdentityPrompt(next.identity_prompt);
    setSoulPrompt(next.soul_prompt);
    setAgentsPrompt(next.agents_prompt);
    setToolsPrompt(next.tools_prompt);
  };

  useEffect(() => {
    if (draftMode) return;
    if (!selected) {
      setName('');
      setCurrentPrompts({
        identity_prompt: '',
        soul_prompt: '',
        agents_prompt: '',
        tools_prompt: '',
      });
      setPromptMode('append');
      setModelConfigId('inherit');
      setAvatarEmoji(null);
      setAvatarColor(null);
      setAvatarUrl(null);
      setAvatarStyleOpen(false);
      applyRuntimePolicyToForm(DEFAULT_RUNTIME_POLICY);
      return;
    }
    setName(selected.name);
    setCurrentPrompts({
      identity_prompt: selected.identity_prompt,
      soul_prompt: selected.soul_prompt,
      agents_prompt: selected.agents_prompt,
      tools_prompt: selected.tools_prompt,
    });
    setPromptMode(selected.prompt_mode);
    setModelConfigId(selected.model_config_id ?? 'inherit');
    setAvatarEmoji(selected.avatar_emoji);
    setAvatarColor(selected.avatar_color);
    setAvatarUrl(selected.avatar_url);
    setAvatarStyleOpen(!!(selected.avatar_emoji || selected.avatar_color));
    applyRuntimePolicyToForm(selected.runtime_policy);
  }, [draftMode, selected?.id]);

  const dirty =
    !draftMode &&
    !!selected &&
    (name.trim() !== selected.name ||
      identityPrompt !== selected.identity_prompt ||
      soulPrompt !== selected.soul_prompt ||
      agentsPrompt !== selected.agents_prompt ||
      toolsPrompt !== selected.tools_prompt ||
      promptMode !== selected.prompt_mode ||
      (modelConfigId === 'inherit' ? null : modelConfigId) !==
        selected.model_config_id ||
      avatarEmoji !== selected.avatar_emoji ||
      avatarColor !== selected.avatar_color ||
      !sameRuntimePolicy(currentRuntimePolicy, selected.runtime_policy));

  const draftDirty =
    draftMode &&
    (!!name.trim() ||
      !!identityPrompt.trim() ||
      !!soulPrompt.trim() ||
      !!agentsPrompt.trim() ||
      !!toolsPrompt.trim() ||
      promptMode !== 'append' ||
      modelConfigId !== 'inherit' ||
      avatarEmoji !== null ||
      avatarColor !== null ||
      !sameRuntimePolicy(currentRuntimePolicy, DEFAULT_RUNTIME_POLICY));

  return {
    name,
    setName,
    identityPrompt,
    setIdentityPrompt,
    soulPrompt,
    setSoulPrompt,
    agentsPrompt,
    setAgentsPrompt,
    toolsPrompt,
    setToolsPrompt,
    promptMode,
    setPromptMode,
    modelConfigId,
    setModelConfigId,
    assistantSection,
    setAssistantSection,
    avatarEmoji,
    setAvatarEmoji,
    avatarColor,
    setAvatarColor,
    avatarUrl,
    setAvatarUrl,
    uploadingAvatar,
    setUploadingAvatar,
    avatarStyleOpen,
    setAvatarStyleOpen,
    currentPrompts,
    setCurrentPrompts,
    dirty,
    draftDirty,
  };
}
