/**
 * 智能体档案管理页（Agent Builder 的 Web 端，路由 /agent-profiles）。
 *
 * 结构：左侧档案列表 + 右侧编辑器；`?agent=<id>` 查询参数同步选中项。
 * 编辑器分块：四段提示词（identity/soul/agents/tools，支持版本历史回滚）、
 * 运行时策略（reasoning effort / context source / 技能与
 * MCP 引用）、生效能力预览（EffectiveCapabilitiesPreview）与治理区
 * （AgentGovernanceSection）。仅自定义档案可编辑（getCustomAgentProfiles，
 * 主 CKQClaw 不可自改）；dirty 状态经 useBlocker + beforeunload 拦截
 * 误触导航离开（createUnsavedNavigationGuard）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  Bot,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AgentPromptEditor } from '../components/agents/AgentPromptEditor';
import { AgentPromptVersionHistory } from '../components/agents/AgentPromptVersionHistory';
import { EffectiveCapabilitiesPreview } from '../components/agents/EffectiveCapabilitiesPreview';
import { AgentGovernanceSection } from '../components/agents/AgentGovernanceSection';
import { AgentDraftSummary } from '../components/agents/AgentDraftSummary';
import { AgentProfilesSidebar } from '../components/agents/AgentProfilesSidebar';
import { AgentDeleteMigrationDialog } from '../components/agents/AgentDeleteMigrationDialog';
import { AgentCapabilitiesSection } from '../components/agents/AgentCapabilitiesSection';
import { AgentIdentitySection } from '../components/agents/AgentIdentitySection';
import { ErrorBoundary } from '../components/common/ErrorBoundary';
import { useAgentProfilesStore } from '../stores/agent-profiles';
import { useAuthStore } from '../stores/auth';
import { useSkillsStore } from '../stores/skills';
import { useMcpServersStore } from '../stores/mcp-servers';
import { getCustomAgentProfiles } from '../utils/agent-product';
import { extractErrorMessage } from '../utils/error';
import { buildAgentPromptPatch } from '../utils/agent-prompts';
import { useUnsavedNavigationGuard } from '../hooks/useUnsavedNavigationGuard';
import { useAgentRuntimePolicy } from '../hooks/useAgentRuntimePolicy';
import { useHostSkillAutosave } from '../hooks/useHostSkillAutosave';
import { useAgentProfileForm } from '../hooks/useAgentProfileForm';
import {
  asApiError,
  DEFAULT_RUNTIME_POLICY,
  sameRuntimePolicy,
} from '../utils/agent-runtime-policy-form';

// ISSUE-12 波 5 单元 5.3：DEFAULT_RUNTIME_POLICY / AGENT_EFFORT_OPTIONS /
// AGENT_EFFORT_VALUES / normalizeRuntimePolicy / sameRuntimePolicy /
// sameSkillSourcePolicy / asApiError 已迁 ../utils/agent-runtime-policy-form.ts
// （原文搬运），经同名 import 回接零调用点改动。

export function AgentProfilesPage() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const requestedProfileId = searchParams.get('agent');
  const {
    profiles,
    modelConfigs = [],
    defaultModelConfigId = null,
    loading,
    profilesError,
    loadProfiles,
    refreshProfile,
    loadProfileGovernance,
    retryRuntimeCleanup,
    loadPromptVersions,
    restorePromptVersion,
    governanceByProfile,
    governanceLoading,
    governanceErrors,
    createProfile,
    updateProfile,
    uploadProfileAvatar,
    removeProfileAvatar,
    deleteProfile,
    setWorkspaceAgentProfile,
  } = useAgentProfilesStore();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftMode, setDraftMode] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [blankDraftRequested, setBlankDraftRequested] = useState(false);
  const [movingWorkspaceJid, setMovingWorkspaceJid] = useState<string | null>(
    null,
  );
  const [workspaceMoveTargets, setWorkspaceMoveTargets] = useState<
    Record<string, string>
  >({});
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState('');
  const [draftStep, setDraftStep] = useState(1);
  const mainAppearance = useAuthStore((state) => state.appearance);

  const customProfiles = useMemo(
    () => getCustomAgentProfiles(profiles),
    [profiles],
  );

  const skillsLoading = useSkillsStore((state) => state.loading);
  const skillsError = useSkillsStore((state) => state.error);
  const loadSkills = useSkillsStore((state) => state.loadSkills);
  const mcpLoading = useMcpServersStore((state) => state.loading);
  const mcpError = useMcpServersStore((state) => state.error);
  const loadMcpServers = useMcpServersStore((state) => state.loadServers);

  // ISSUE-12 波 5 单元 5.3：运行时策略状态簇/applyRuntimePolicyToForm/
  // 错误与选项 memos 已迁 ../hooks/useAgentRuntimePolicy.ts（原文搬运，
  // hook 内自读 skills/mcpServers 两 store），同名解构零调用点改动。
  const {
    effort,
    setEffort,
    contextSource,
    setContextSource,
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
  } = useAgentRuntimePolicy();

  // ISSUE-12 波 5 单元 5.1：导航守卫（shouldBlockNavigation/useBlocker/
  // useBeforeUnload/阻断确认效应/?create=1 路由效应）已迁
  // ../hooks/useUnsavedNavigationGuard.ts（原文搬运，getter 惰性取值）。
  // 调用点必须在下方 selection 效应（消费 setAllowedSearchParams）之前；
  // getHasUnsavedChanges 惰性取值打破其晚于本行的声明顺序。
  const requestBlankDraft = useCallback(() => setBlankDraftRequested(true), []);
  const { setAllowedSearchParams } = useUnsavedNavigationGuard({
    getHasUnsavedChanges: () => hasUnsavedChanges,
    searchParams,
    requestBlankDraft,
  });

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    void loadSkills();
    void loadMcpServers();
  }, [loadMcpServers, loadSkills]);

  useEffect(() => {
    if (draftMode) return;
    if (
      requestedProfileId &&
      customProfiles.some((profile) => profile.id === requestedProfileId)
    ) {
      if (selectedId !== requestedProfileId) {
        setSelectedId(requestedProfileId);
      }
      return;
    }
    if (
      selectedId &&
      customProfiles.some((profile) => profile.id === selectedId)
    ) {
      if (requestedProfileId && requestedProfileId !== selectedId) {
        setAllowedSearchParams({ agent: selectedId }, { replace: true });
      }
      return;
    }
    const fallbackId = customProfiles[0]?.id ?? null;
    setSelectedId(fallbackId);
    if (requestedProfileId) {
      setAllowedSearchParams(fallbackId ? { agent: fallbackId } : {}, {
        replace: true,
      });
    }
  }, [
    customProfiles,
    draftMode,
    requestedProfileId,
    selectedId,
    setAllowedSearchParams,
  ]);

  const selected = useMemo(
    () => customProfiles.find((profile) => profile.id === selectedId) ?? null,
    [customProfiles, selectedId],
  );
  selectedIdRef.current = selectedId;

  useEffect(() => {
    if (!selected || location.hash !== '#agent-capabilities') return;
    const frame = requestAnimationFrame(() => {
      document
        .getElementById('agent-capabilities')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return () => cancelAnimationFrame(frame);
  }, [location.hash, selected]);

  // ISSUE-12 波 5 单元 5.4：表单状态簇（name/四段提示词/promptMode/
  // modelConfigId/头像四态）、currentPrompts、回填效应与
  // dirty/draftDirty 已迁 ../hooks/useAgentProfileForm.ts（原文搬运；
  // 回填效应依赖数组 [draftMode, selected?.id] 刻意不补全，逐字保留），
  // 同名解构零调用点改动。
  const {
    name,
    setName,
    promptMode,
    setPromptMode,
    modelConfigId,
    setModelConfigId,
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
  } = useAgentProfileForm({
    selected,
    draftMode,
    applyRuntimePolicyToForm,
    currentRuntimePolicy,
  });

  useEffect(() => {
    if (draftMode || !selected) return;
    void loadProfileGovernance(selected.id).catch((err) => {
      toast.error(extractErrorMessage(err, '加载智能体治理数据失败'));
    });
  }, [draftMode, loadProfileGovernance, selected?.id]);

  const editorUnsavedChanges = dirty || draftDirty;
  const hasUnsavedChanges = editorUnsavedChanges;

  const governance = selected ? governanceByProfile[selected.id] : undefined;
  const governanceBusy = selected ? !!governanceLoading[selected.id] : false;
  const governanceError = selected ? governanceErrors[selected.id] : undefined;
  // ISSUE-12 波 5 单元 5.2：宿主机 Skills 自动保存簇（治理同步效应与
  // persistHostSkillPolicy/双 retry/双 change 处理器）已迁
  // ../hooks/useHostSkillAutosave.ts（原文搬运），同名解构零调用点改动。
  const {
    handleRetryProfileRuntimeCleanup,
    handleRetryHostSkillSave,
    handleHostSkillsModeChange,
    handleHostSkillIdsChange,
  } = useHostSkillAutosave({
    selected,
    draftMode,
    governance,
    updateProfile,
    refreshProfile,
    loadProfileGovernance,
    retryRuntimeCleanup,
    hostSkillsMode,
    hostSkillIds,
    hostSkillsSaveStatus,
    runtimeCleanupRepairing,
    hostSkillsSavingRef,
    selectedIdRef,
    confirmedHostSkillPolicyRef,
    attemptedHostSkillPolicyRef,
    setHostSkillsSaving,
    setHostSkillsSaveStatus,
    setHostSkillsMode,
    setHostSkillIds,
    setRuntimeCleanupRepairing,
  });
  const confirmDiscardUnsavedChanges = () =>
    !hasUnsavedChanges ||
    confirm('当前智能体有未保存修改，继续会丢失。是否继续？');
  const confirmDiscardEditorChanges = () =>
    !editorUnsavedChanges ||
    confirm('当前智能体有未保存修改，继续会丢失。是否继续？');

  const handleSelectProfile = (profileId: string) => {
    if (profileId === selectedId && !draftMode) {
      return;
    }
    if (!confirmDiscardUnsavedChanges()) return;
    setDraftMode(false);
    setSelectedId(profileId);
    setAllowedSearchParams({ agent: profileId }, { replace: true });
  };

  const handleRefreshProfiles = () => {
    if (!confirmDiscardUnsavedChanges()) return;
    void loadProfiles();
  };

  const beginBlankDraft = () => {
    setDraftMode(true);
    setDraftStep(1);
    setSelectedId(null);
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
  };

  useEffect(() => {
    if (!blankDraftRequested) return;
    setBlankDraftRequested(false);
    if (!confirmDiscardEditorChanges()) return;
    beginBlankDraft();
  }, [blankDraftRequested]);

  const handleCreateNewAgent = () => {
    if (!confirmDiscardEditorChanges()) return;
    beginBlankDraft();
  };

  const handleDiscardDraft = () => {
    if (draftDirty && !confirm('确认放弃当前智能体草稿？')) return;
    setDraftMode(false);
    const fallback = customProfiles[0];
    setSelectedId(fallback?.id ?? null);
  };

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed || capabilityError) return;
    setCreating(true);
    try {
      const profile = await createProfile({
        name: trimmed,
        ...currentPrompts,
        prompt_mode: promptMode,
        avatar_emoji: avatarEmoji,
        avatar_color: avatarColor,
        model_config_id: modelConfigId === 'inherit' ? null : modelConfigId,
        runtime_policy: currentRuntimePolicy,
      });
      setDraftMode(false);
      setSelectedId(profile.id);
      setAllowedSearchParams({ agent: profile.id }, { replace: true });
      toast.success(
        '已创建智能体；当前未绑定工作区，Session 与 Memory 均和 CKQClaw 隔离',
      );
    } catch (err) {
      toast.error(extractErrorMessage(err, '创建失败'));
    } finally {
      setCreating(false);
    }
  };

  const handleSave = async () => {
    if (!selected || !name.trim() || capabilityError) return;
    setSaving(true);
    try {
      const changes: Parameters<typeof updateProfile>[1] = {};
      if (name.trim() !== selected.name) changes.name = name.trim();
      const promptPatch = buildAgentPromptPatch(currentPrompts, promptMode, {
        identity_prompt: selected.identity_prompt,
        soul_prompt: selected.soul_prompt,
        agents_prompt: selected.agents_prompt,
        tools_prompt: selected.tools_prompt,
        prompt_mode: selected.prompt_mode,
      });
      if (promptPatch) Object.assign(changes, promptPatch);
      if (avatarEmoji !== selected.avatar_emoji) {
        changes.avatar_emoji = avatarEmoji;
      }
      if (avatarColor !== selected.avatar_color) {
        changes.avatar_color = avatarColor;
      }
      const persistedModelConfigId =
        modelConfigId === 'inherit' ? null : modelConfigId;
      if (persistedModelConfigId !== selected.model_config_id) {
        changes.model_config_id = persistedModelConfigId;
      }
      if (!sameRuntimePolicy(currentRuntimePolicy, selected.runtime_policy)) {
        changes.runtime_policy = currentRuntimePolicy;
      }
      if (Object.keys(changes).length === 0) return;
      const profile = await updateProfile(selected.id, changes);
      setSelectedId(profile.id);
      toast.success('已保存');
    } catch (err) {
      if (selected && asApiError(err)?.body?.persisted === true) {
        void loadProfileGovernance(selected.id).catch(() => undefined);
      }
      toast.error(extractErrorMessage(err, '保存失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleAvatarUpload = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !selected || draftMode) return;
    if (file.size > 3 * 1024 * 1024) {
      toast.error('图片文件不能超过 3MB');
      return;
    }
    if (
      !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(
        file.type,
      )
    ) {
      toast.error('仅支持 jpg、png、gif、webp 格式');
      return;
    }
    setUploadingAvatar(true);
    try {
      const profile = await uploadProfileAvatar(selected.id, file);
      setAvatarUrl(profile.avatar_url);
      toast.success('智能体头像已更新');
    } catch (error) {
      toast.error(extractErrorMessage(error, '上传头像失败'));
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleInheritMainAvatar = async () => {
    if (!selected || draftMode) {
      setAvatarEmoji(null);
      setAvatarColor(null);
      setAvatarUrl(null);
      setAvatarStyleOpen(false);
      return;
    }
    setUploadingAvatar(true);
    try {
      if (selected.avatar_url) await removeProfileAvatar(selected.id);
      const profile = await updateProfile(selected.id, {
        avatar_emoji: null,
        avatar_color: null,
      });
      setAvatarEmoji(profile.avatar_emoji);
      setAvatarColor(profile.avatar_color);
      setAvatarUrl(profile.avatar_url);
      setAvatarStyleOpen(false);
      toast.success('已改为继承主 CKQClaw 头像');
    } catch (error) {
      toast.error(extractErrorMessage(error, '恢复主头像失败'));
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleMoveWorkspace = async (
    workspaceJid: string,
    targetProfileId: string,
  ) => {
    if (!selected || targetProfileId === selected.id) return;
    const workspace = governance?.workspaces.find(
      (candidate) => candidate.jid === workspaceJid,
    );
    if (workspace?.is_home) {
      toast.error('Home Workspace 固定归属内置 CKQClaw，不能迁移');
      return;
    }
    const target = profiles.find((profile) => profile.id === targetProfileId);
    if (
      !confirm(
        `确认将工作区「${workspace?.name ?? workspaceJid}」迁移到「${target?.name ?? '目标智能体'}」？工作区文件、Session、渠道绑定和 Workspace Memory 都会随工作区保留，并对目标智能体可用。`,
      )
    ) {
      return;
    }
    setMovingWorkspaceJid(workspaceJid);
    try {
      await setWorkspaceAgentProfile(workspaceJid, targetProfileId);
      toast.success(`工作区已迁移到「${target?.name ?? '目标智能体'}」`);
      await Promise.allSettled([
        loadProfileGovernance(selected.id),
        loadProfileGovernance(targetProfileId),
      ]);
      setWorkspaceMoveTargets((current) => {
        const next = { ...current };
        delete next[workspaceJid];
        return next;
      });
    } catch (err) {
      toast.error(extractErrorMessage(err, '迁移工作区失败'));
    } finally {
      setMovingWorkspaceJid(null);
    }
  };

  const deleteSelectedProfile = async () => {
    if (!selected) return;
    await deleteProfile(selected.id);
    const fallback = customProfiles.find(
      (profile) => profile.id !== selected.id,
    );
    setSelectedId(fallback?.id ?? null);
    setAllowedSearchParams(fallback ? { agent: fallback.id } : {}, {
      replace: true,
    });
    toast.success('已删除');
  };

  const handleDelete = async () => {
    if (!selected || selected.is_default) return;
    if (dirty && !confirmDiscardUnsavedChanges()) return;
    setDeleting(true);
    try {
      const latestGovernance = await loadProfileGovernance(selected.id);
      if (latestGovernance.workspaces.length > 0) {
        const fallback =
          customProfiles.find((profile) => profile.id !== selected.id) ??
          profiles.find(
            (profile) => profile.id !== selected.id && profile.is_default,
          );
        if (!fallback) {
          toast.error('没有可迁移工作区的目标智能体');
          return;
        }
        setDeleteTargetId(fallback.id);
        setDeleteDialogOpen(true);
        return;
      }
      if (latestGovernance.channel_mounts.length > 0) {
        toast.error('该智能体仍有渠道绑定，请先在“渠道绑定”页面解绑或换绑');
        return;
      }
      if (!confirm(`确认删除智能体「${selected.name}」？`)) return;
      await deleteSelectedProfile();
    } catch (err) {
      toast.error(extractErrorMessage(err, '删除失败'));
    } finally {
      setDeleting(false);
    }
  };

  const handleMigrateAndDelete = async () => {
    if (!selected || !governance || !deleteTargetId) return;
    setDeleting(true);
    try {
      for (const workspace of governance.workspaces) {
        await setWorkspaceAgentProfile(workspace.jid, deleteTargetId);
      }
      await deleteSelectedProfile();
      setDeleteDialogOpen(false);
    } catch (err) {
      toast.error(
        extractErrorMessage(
          err,
          '迁移或删除失败；已完成的工作区迁移会保留，可重试剩余操作',
        ),
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="min-h-full bg-background lg:flex">
      <AgentProfilesSidebar
        customProfiles={customProfiles}
        loading={loading}
        profilesError={profilesError}
        draftMode={draftMode}
        setDraftMode={setDraftMode}
        selectedId={selectedId}
        name={name}
        handleRefreshProfiles={handleRefreshProfiles}
        handleCreateNewAgent={handleCreateNewAgent}
        handleSelectProfile={handleSelectProfile}
      />
      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-5xl p-4 pb-24 sm:p-6 sm:pb-24 lg:p-8">
          {!selected && !draftMode ? (
            <div className="flex min-h-[420px] flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 text-center">
              <div className="grid h-12 w-12 place-items-center rounded-full bg-muted text-muted-foreground">
                <Bot className="h-5 w-5" />
              </div>
              <div className="mt-4 text-sm font-medium text-foreground">
                {customProfiles.length === 0
                  ? '还没有自定义智能体'
                  : '选择一个智能体'}
              </div>
              <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
                {customProfiles.length === 0
                  ? '创建一个专门处理特定任务的智能体。'
                  : '从左侧选择智能体查看配置，或创建一个新的智能体。'}
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              <header>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground">
                      {name.trim() || '新智能体'}
                    </h1>
                    {draftMode && <Badge variant="secondary">草稿</Badge>}
                    {hasUnsavedChanges && (
                      <Badge variant="outline">有未保存修改</Badge>
                    )}
                  </div>
                  <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">
                    管理智能体的身份和能力，以及所属工作区和消息渠道。
                  </p>
                </div>
              </header>

              {!draftMode && governance?.runtime_cleanup_pending && (
                <div
                  role="status"
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-foreground"
                >
                  <div>
                    <div className="font-medium">
                      智能体配置已保存，但工作区运行时清理未完成
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      为避免旧配置继续运行，相关工作区已暂停；清理成功后会自动恢复。
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={runtimeCleanupRepairing}
                    onClick={() => void handleRetryProfileRuntimeCleanup()}
                  >
                    {runtimeCleanupRepairing ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4" />
                    )}
                    重试清理
                  </Button>
                </div>
              )}

              {draftMode && (
                <nav
                  aria-label="创建智能体步骤"
                  className="overflow-x-auto rounded-xl border bg-card p-2"
                >
                  <ol className="flex min-w-[680px] gap-1">
                    {[
                      [1, '基本信息'],
                      [2, '四段提示词'],
                      [3, '宿主机配置'],
                      [4, 'Skills / MCP'],
                      [5, '确认创建'],
                    ].map(([step, label]) => (
                      <li key={step} className="min-w-0 flex-1">
                        <button
                          type="button"
                          onClick={() => setDraftStep(Number(step))}
                          aria-current={draftStep === step ? 'step' : undefined}
                          className={`w-full rounded-lg px-3 py-2 text-left text-xs transition-colors ${draftStep === step ? 'bg-primary text-primary-foreground' : Number(step) < draftStep ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted'}`}
                        >
                          <span className="mr-1.5 font-semibold">{step}</span>
                          {label}
                        </button>
                      </li>
                    ))}
                  </ol>
                </nav>
              )}

              <div className="space-y-5">
                <div className="space-y-5">
                  <AgentIdentitySection
                    draftMode={draftMode}
                    draftStep={draftStep}
                    mainAppearance={mainAppearance}
                    name={name}
                    setName={setName}
                    modelConfigId={modelConfigId}
                    setModelConfigId={setModelConfigId}
                    modelConfigs={modelConfigs}
                    defaultModelConfigId={defaultModelConfigId}
                    effort={effort}
                    setEffort={setEffort}
                    avatarUrl={avatarUrl}
                    avatarEmoji={avatarEmoji}
                    setAvatarEmoji={setAvatarEmoji}
                    avatarColor={avatarColor}
                    setAvatarColor={setAvatarColor}
                    uploadingAvatar={uploadingAvatar}
                    avatarStyleOpen={avatarStyleOpen}
                    setAvatarStyleOpen={setAvatarStyleOpen}
                    avatarInputRef={avatarInputRef}
                    handleAvatarUpload={handleAvatarUpload}
                    handleInheritMainAvatar={handleInheritMainAvatar}
                    contextSource={contextSource}
                    setContextSource={setContextSource}
                  />

                  {draftMode && draftStep === 3 && (
                    <section className="overflow-hidden rounded-xl border border-border bg-card">
                      <div className="border-b px-5 py-4">
                        <h2 className="text-sm font-semibold">宿主机配置</h2>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          决定是否将宿主机的 ~/.claude 作为完整用户配置层叠加；
                          工作区仍是运行目录。宿主机 MCP 随配置加载，CKQClaw MCP
                          与宿主机 Skills 在“能力配置”中独立设置。
                        </p>
                      </div>
                      <div
                        className="grid gap-3 p-5 sm:grid-cols-2"
                        role="radiogroup"
                        aria-label="宿主机配置"
                      >
                        <button
                          type="button"
                          role="radio"
                          aria-checked={contextSource === 'managed'}
                          onClick={() => setContextSource('managed')}
                          className={`rounded-lg border p-4 text-left ${contextSource === 'managed' ? 'border-primary bg-primary/5' : 'hover:bg-muted'}`}
                        >
                          <span className="block text-sm font-medium">
                            CKQClaw 托管
                          </span>
                          <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                            不加载宿主机原生配置。Skills 与 MCP
                            仍按下一步的独立能力策略加载。
                          </span>
                        </button>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={contextSource === 'host_claude'}
                          onClick={() => setContextSource('host_claude')}
                          className={`rounded-lg border p-4 text-left disabled:cursor-not-allowed disabled:opacity-50 ${contextSource === 'host_claude' ? 'border-primary bg-primary/5' : 'hover:bg-muted'}`}
                        >
                          <span className="block text-sm font-medium">
                            加载宿主机 ~/.claude
                          </span>
                          <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                            加载设置、提示词、Rules、Agents、Commands、Hooks、
                            Workflows、Output Styles 与宿主机 MCP； CKQClaw MCP
                            和宿主机 Skills 仍由下一步单独控制。
                          </span>
                        </button>
                      </div>
                    </section>
                  )}

                  <div hidden={draftMode && draftStep !== 2}>
                    <AgentPromptEditor
                      value={currentPrompts}
                      onChange={setCurrentPrompts}
                    />
                  </div>

                  {!draftMode && selected && (
                    <>
                      <AgentPromptVersionHistory
                        profileId={selected.id}
                        currentVersion={selected.version}
                        currentPrompts={currentPrompts}
                        loadVersions={loadPromptVersions}
                        restoreVersion={restorePromptVersion}
                        confirmDiscardUnsavedChanges={
                          confirmDiscardUnsavedChanges
                        }
                        onRestored={(profile) => {
                          setCurrentPrompts({
                            identity_prompt: profile.identity_prompt,
                            soul_prompt: profile.soul_prompt,
                            agents_prompt: profile.agents_prompt,
                            tools_prompt: profile.tools_prompt,
                          });
                          setPromptMode(profile.prompt_mode);
                        }}
                      />
                    </>
                  )}

                  {draftMode && draftStep === 5 && (
                    <AgentDraftSummary
                      name={name}
                      currentPrompts={currentPrompts}
                      modelConfigId={modelConfigId}
                      defaultModelConfigId={defaultModelConfigId}
                      modelConfigs={modelConfigs}
                      effort={effort}
                      contextSource={contextSource}
                      skillsMode={skillsMode}
                      skillIds={skillIds}
                      hostSkillsMode={hostSkillsMode}
                      hostSkillIds={hostSkillIds}
                      mcpMode={mcpMode}
                      mcpIds={mcpIds}
                      capabilityError={capabilityError}
                    />
                  )}

                  <AgentCapabilitiesSection
                    draftMode={draftMode}
                    draftStep={draftStep}
                    skillsMode={skillsMode}
                    setSkillsMode={setSkillsMode}
                    skillIds={skillIds}
                    setSkillIds={setSkillIds}
                    skillOptions={skillOptions}
                    hostSkillsMode={hostSkillsMode}
                    hostSkillIds={hostSkillIds}
                    handleHostSkillsModeChange={handleHostSkillsModeChange}
                    handleHostSkillIdsChange={handleHostSkillIdsChange}
                    hostSkillOptions={hostSkillOptions}
                    skillsLoading={skillsLoading}
                    skillsError={skillsError}
                    hostSkillsSaving={hostSkillsSaving}
                    runtimeCleanupRepairing={runtimeCleanupRepairing}
                    hostSkillsSaveStatus={hostSkillsSaveStatus}
                    handleRetryHostSkillSave={handleRetryHostSkillSave}
                    managedSkillsError={managedSkillsError}
                    hostSkillsError={hostSkillsError}
                    mcpMode={mcpMode}
                    setMcpMode={setMcpMode}
                    mcpOptions={mcpOptions}
                    mcpIds={mcpIds}
                    setMcpIds={setMcpIds}
                    mcpLoading={mcpLoading}
                    mcpError={mcpError}
                  />
                  {!draftMode && selected && (
                    <ErrorBoundary resetKeys={[selected.id]}>
                      <EffectiveCapabilitiesPreview
                        profileId={selected.id}
                        runtimePolicy={currentRuntimePolicy}
                        workspaces={governance?.workspaces ?? []}
                      />
                    </ErrorBoundary>
                  )}
                  {!draftMode && selected && (
                    <AgentGovernanceSection
                      selected={selected}
                      profiles={profiles}
                      governance={governance}
                      busy={governanceBusy}
                      error={governanceError}
                      workspaceMoveTargets={workspaceMoveTargets}
                      movingWorkspaceJid={movingWorkspaceJid}
                      onRefresh={() => void loadProfileGovernance(selected.id)}
                      onMoveTargetChange={(workspaceJid, targetProfileId) =>
                        setWorkspaceMoveTargets((current) => ({
                          ...current,
                          [workspaceJid]: targetProfileId,
                        }))
                      }
                      onMoveWorkspace={(workspaceJid, targetProfileId) =>
                        void handleMoveWorkspace(workspaceJid, targetProfileId)
                      }
                    />
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 border-t border-border pt-5">
                  <div className="mr-auto text-xs text-muted-foreground">
                    {draftMode
                      ? '完成配置后创建智能体'
                      : dirty
                        ? '有未保存的修改'
                        : '所有更改已保存'}
                  </div>
                  {draftMode ? (
                    <>
                      <Button variant="outline" onClick={handleDiscardDraft}>
                        <X className="h-4 w-4" />
                        放弃草稿
                      </Button>
                      {draftStep > 1 && (
                        <Button
                          variant="outline"
                          onClick={() =>
                            setDraftStep((step) => Math.max(1, step - 1))
                          }
                        >
                          上一步
                        </Button>
                      )}
                      {draftStep < 5 ? (
                        <Button
                          onClick={() =>
                            setDraftStep((step) => Math.min(5, step + 1))
                          }
                        >
                          下一步
                          <ArrowRight className="h-4 w-4" />
                        </Button>
                      ) : (
                        <Button
                          onClick={handleCreate}
                          disabled={
                            creating || !name.trim() || !!capabilityError
                          }
                        >
                          {creating ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Plus className="h-4 w-4" />
                          )}
                          创建智能体
                        </Button>
                      )}
                    </>
                  ) : (
                    <>
                      <Button
                        onClick={handleSave}
                        disabled={
                          !dirty ||
                          saving ||
                          hostSkillsSaving ||
                          runtimeCleanupRepairing ||
                          !name.trim() ||
                          !!capabilityError
                        }
                      >
                        {saving ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Save className="h-4 w-4" />
                        )}
                        保存
                      </Button>
                      <Button
                        variant="outline"
                        onClick={handleDelete}
                        disabled={!selected || selected.is_default || deleting}
                        className="text-error hover:bg-error-bg hover:text-error"
                      >
                        <Trash2 className="h-4 w-4" />
                        删除
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      <AgentDeleteMigrationDialog
        deleteDialogOpen={deleteDialogOpen}
        setDeleteDialogOpen={setDeleteDialogOpen}
        deleting={deleting}
        selected={selected}
        governance={governance}
        profiles={profiles}
        deleteTargetId={deleteTargetId}
        setDeleteTargetId={setDeleteTargetId}
        handleMigrateAndDelete={handleMigrateAndDelete}
      />
    </div>
  );
}
