import {
  useEffect,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import { toast } from 'sonner';
import { useAgentProfilesStore } from '../stores/agent-profiles';
import type { HostSkillSaveStatus } from '../components/agents/AgentSkillsPolicyEditor';
import { extractErrorMessage } from '../utils/error';
import {
  getHostSkillPolicy,
  hostSkillPolicyForMode,
  type RuntimePolicyMode,
} from '../utils/agent-runtime-policy';
import {
  asApiError,
  sameSkillSourcePolicy,
} from '../utils/agent-runtime-policy-form';

// ISSUE-12 波 5 单元 5.2：宿主机 Skills 自动保存簇自
// web/src/pages/AgentProfilesPage.tsx 原文搬运（原 380-399 治理同步效应与
// 568-744 五处理器共 197 行：persistHostSkillPolicy 超时对账/竞态守卫/
// 双 retry 与 mode/ids change 处理器）。状态切片与 store 动作经 input
// 注入（hostSkills 族状态归 useAgentRuntimePolicy 所有，5.3b 先例）；
// 超时对账/竞态守卫 ref 语义逐字保留。搬运体逐字节一致。

type AgentProfilesStoreState = ReturnType<
  typeof useAgentProfilesStore.getState
>;
type AgentProfileRow = AgentProfilesStoreState['profiles'][number];
type GovernanceSnapshot =
  AgentProfilesStoreState['governanceByProfile'][string];
type HostSkillPolicy = ReturnType<typeof hostSkillPolicyForMode>;

export interface UseHostSkillAutosaveInput {
  selected: AgentProfileRow | null;
  draftMode: boolean;
  governance: GovernanceSnapshot | undefined;
  updateProfile: AgentProfilesStoreState['updateProfile'];
  refreshProfile: AgentProfilesStoreState['refreshProfile'];
  loadProfileGovernance: AgentProfilesStoreState['loadProfileGovernance'];
  retryRuntimeCleanup: AgentProfilesStoreState['retryRuntimeCleanup'];
  hostSkillsMode: RuntimePolicyMode;
  hostSkillIds: string[];
  hostSkillsSaveStatus: HostSkillSaveStatus;
  runtimeCleanupRepairing: boolean;
  hostSkillsSavingRef: RefObject<boolean>;
  selectedIdRef: RefObject<string | null>;
  confirmedHostSkillPolicyRef: RefObject<HostSkillPolicy>;
  attemptedHostSkillPolicyRef: RefObject<HostSkillPolicy>;
  setHostSkillsSaving: Dispatch<SetStateAction<boolean>>;
  setHostSkillsSaveStatus: Dispatch<SetStateAction<HostSkillSaveStatus>>;
  setHostSkillsMode: Dispatch<SetStateAction<RuntimePolicyMode>>;
  setHostSkillIds: Dispatch<SetStateAction<string[]>>;
  setRuntimeCleanupRepairing: Dispatch<SetStateAction<boolean>>;
}

export function useHostSkillAutosave(input: UseHostSkillAutosaveInput) {
  const {
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
  } = input;

  useEffect(() => {
    if (
      draftMode ||
      !selected ||
      !governance?.runtime_cleanup_pending ||
      governance.profile.id !== selected.id ||
      hostSkillsSavingRef.current
    ) {
      return;
    }
    const persistedPolicy = getHostSkillPolicy(selected.runtime_policy);
    confirmedHostSkillPolicyRef.current = {
      mode: persistedPolicy.mode,
      ids: [...persistedPolicy.ids],
    };
    attemptedHostSkillPolicyRef.current = {
      mode: persistedPolicy.mode,
      ids: [...persistedPolicy.ids],
    };
    setHostSkillsSaveStatus('warning');
  }, [draftMode, governance, selected]);

  const persistHostSkillPolicy = async (
    nextPolicy: ReturnType<typeof hostSkillPolicyForMode>,
  ) => {
    if (!selected || draftMode || hostSkillsSavingRef.current) return;
    const profileId = selected.id;
    attemptedHostSkillPolicyRef.current = {
      mode: nextPolicy.mode,
      ids: [...nextPolicy.ids],
    };
    hostSkillsSavingRef.current = true;
    setHostSkillsSaving(true);
    setHostSkillsSaveStatus('idle');
    try {
      await updateProfile(profileId, {
        runtime_policy: {
          skills: {
            host: nextPolicy,
          },
        },
      });
      if (selectedIdRef.current === profileId) {
        attemptedHostSkillPolicyRef.current = {
          mode: nextPolicy.mode,
          ids: [...nextPolicy.ids],
        };
        confirmedHostSkillPolicyRef.current = {
          mode: nextPolicy.mode,
          ids: [...nextPolicy.ids],
        };
        setHostSkillsSaveStatus('saved');
        toast.success('宿主机 Skills 已保存并生效');
      }
    } catch (err) {
      if (selectedIdRef.current === profileId) {
        // The user may have visited another profile and returned while this
        // request was in flight. Restore this request's attempted policy so a
        // retry cannot accidentally send the other render's stale value.
        attemptedHostSkillPolicyRef.current = {
          mode: nextPolicy.mode,
          ids: [...nextPolicy.ids],
        };
        const apiError = asApiError(err);
        if (apiError?.body?.persisted === true) {
          confirmedHostSkillPolicyRef.current = {
            mode: nextPolicy.mode,
            ids: [...nextPolicy.ids],
          };
          setHostSkillsMode(nextPolicy.mode);
          setHostSkillIds([...nextPolicy.ids]);
          setHostSkillsSaveStatus('warning');
          toast.warning('配置已保存，但工作区运行时清理失败，请重试清理');
        } else if (apiError?.status === 0 || apiError?.status === 408) {
          try {
            const [freshProfile, freshGovernance] = await Promise.all([
              refreshProfile(profileId),
              loadProfileGovernance(profileId),
            ]);
            if (selectedIdRef.current === profileId) {
              attemptedHostSkillPolicyRef.current = {
                mode: nextPolicy.mode,
                ids: [...nextPolicy.ids],
              };
              const freshPolicy = getHostSkillPolicy(
                freshProfile.runtime_policy,
              );
              confirmedHostSkillPolicyRef.current = {
                mode: freshPolicy.mode,
                ids: [...freshPolicy.ids],
              };
              if (sameSkillSourcePolicy(freshPolicy, nextPolicy)) {
                setHostSkillsMode(freshPolicy.mode);
                setHostSkillIds([...freshPolicy.ids]);
                if (freshGovernance.runtime_cleanup_pending) {
                  setHostSkillsSaveStatus('warning');
                  toast.warning('配置已保存，但工作区运行时清理仍未完成');
                } else {
                  setHostSkillsSaveStatus('saved');
                  toast.success('宿主机 Skills 已确认保存并生效');
                }
              } else {
                // The timed-out PATCH may still be completing on the server.
                // Keep the requested selection visible and offer an
                // idempotent retry instead of claiming either outcome.
                setHostSkillsMode(nextPolicy.mode);
                setHostSkillIds([...nextPolicy.ids]);
                setHostSkillsSaveStatus('uncertain');
                toast.warning('连接中断，暂时无法确认宿主机 Skills 状态');
              }
            }
          } catch {
            if (selectedIdRef.current === profileId) {
              attemptedHostSkillPolicyRef.current = {
                mode: nextPolicy.mode,
                ids: [...nextPolicy.ids],
              };
              setHostSkillsMode(nextPolicy.mode);
              setHostSkillIds([...nextPolicy.ids]);
              setHostSkillsSaveStatus('uncertain');
              toast.warning('连接中断，暂时无法确认宿主机 Skills 状态');
            }
          }
        } else {
          const confirmed = confirmedHostSkillPolicyRef.current;
          setHostSkillsMode(confirmed.mode);
          setHostSkillIds([...confirmed.ids]);
          setHostSkillsSaveStatus('error');
          toast.error(extractErrorMessage(err, '宿主机 Skills 保存失败'));
        }
      }
    } finally {
      hostSkillsSavingRef.current = false;
      setHostSkillsSaving(false);
    }
  };

  const handleRetryProfileRuntimeCleanup = async () => {
    if (!selected || draftMode || runtimeCleanupRepairing) return;
    const profileId = selected.id;
    setRuntimeCleanupRepairing(true);
    try {
      await retryRuntimeCleanup(profileId);
      if (selectedIdRef.current === profileId) {
        setHostSkillsSaveStatus('saved');
        toast.success('工作区运行时清理已完成');
      }
    } catch (err) {
      if (selectedIdRef.current === profileId) {
        setHostSkillsSaveStatus('warning');
        toast.error(extractErrorMessage(err, '工作区运行时清理失败'));
      }
    } finally {
      setRuntimeCleanupRepairing(false);
    }
  };

  const handleRetryHostSkillSave = () => {
    if (hostSkillsSavingRef.current || draftMode || !selected) return;
    if (hostSkillsSaveStatus === 'warning') {
      void handleRetryProfileRuntimeCleanup();
      return;
    }
    const attempted = attemptedHostSkillPolicyRef.current;
    setHostSkillsMode(attempted.mode);
    setHostSkillIds([...attempted.ids]);
    void persistHostSkillPolicy(attempted);
  };

  const handleHostSkillsModeChange = (mode: RuntimePolicyMode) => {
    if (hostSkillsSavingRef.current || mode === hostSkillsMode) return;
    const nextPolicy = hostSkillPolicyForMode(mode, hostSkillIds);
    setHostSkillsMode(nextPolicy.mode);
    setHostSkillIds(nextPolicy.ids);
    setHostSkillsSaveStatus('idle');
    if (
      !draftMode &&
      selected &&
      !(nextPolicy.mode === 'custom' && nextPolicy.ids.length === 0)
    ) {
      void persistHostSkillPolicy(nextPolicy);
    }
  };

  const handleHostSkillIdsChange = (ids: string[]) => {
    if (hostSkillsSavingRef.current) return;
    const nextPolicy = hostSkillPolicyForMode(hostSkillsMode, ids);
    setHostSkillIds(nextPolicy.ids);
    setHostSkillsSaveStatus('idle');
    if (
      !draftMode &&
      selected &&
      nextPolicy.mode === 'custom' &&
      nextPolicy.ids.length > 0 &&
      nextPolicy.ids.length <= 100
    ) {
      void persistHostSkillPolicy(nextPolicy);
    }
  };

  return {
    persistHostSkillPolicy,
    handleRetryProfileRuntimeCleanup,
    handleRetryHostSkillSave,
    handleHostSkillsModeChange,
    handleHostSkillIdsChange,
  };
}
