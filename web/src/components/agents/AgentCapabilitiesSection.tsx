import type { Dispatch, SetStateAction } from 'react';
import {
  AgentSkillsPolicyEditor,
  type HostSkillSaveStatus,
} from './AgentSkillsPolicyEditor';
import {
  PolicyResourcePicker,
  type PolicyResourceOption,
} from './PolicyResourcePicker';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { RuntimePolicyMode } from '@/utils/agent-runtime-policy';

// ISSUE-12 波 5 单元 5.8：能力配置区（能力来源编辑器 + CKQClaw MCP 策略 +
// SDK 自动压缩说明）自 web/src/pages/AgentProfilesPage.tsx 原文搬运（原
// 1133-1236）。JSX 逐字节一致；状态与处理器经 props 注入（能力策略状态归
// useAgentRuntimePolicy 所有 5.3b、autosave 处理器归 useHostSkillAutosave
// 所有 5.2，页面同名转发）。

export interface AgentCapabilitiesSectionProps {
  draftMode: boolean;
  draftStep: number;
  skillsMode: RuntimePolicyMode;
  setSkillsMode: Dispatch<SetStateAction<RuntimePolicyMode>>;
  skillIds: string[];
  setSkillIds: Dispatch<SetStateAction<string[]>>;
  skillOptions: PolicyResourceOption[];
  hostSkillsMode: RuntimePolicyMode;
  hostSkillIds: string[];
  handleHostSkillsModeChange: (mode: RuntimePolicyMode) => void;
  handleHostSkillIdsChange: (ids: string[]) => void;
  hostSkillOptions: PolicyResourceOption[];
  skillsLoading: boolean;
  skillsError: string | null;
  hostSkillsSaving: boolean;
  runtimeCleanupRepairing: boolean;
  hostSkillsSaveStatus: HostSkillSaveStatus;
  handleRetryHostSkillSave: () => void;
  managedSkillsError: string | null;
  hostSkillsError: string | null;
  mcpMode: RuntimePolicyMode;
  setMcpMode: Dispatch<SetStateAction<RuntimePolicyMode>>;
  mcpOptions: PolicyResourceOption[];
  mcpIds: string[];
  setMcpIds: Dispatch<SetStateAction<string[]>>;
  mcpLoading: boolean;
  mcpError: string | null;
}

export function AgentCapabilitiesSection(props: AgentCapabilitiesSectionProps) {
  const {
    draftMode,
    draftStep,
    skillsMode,
    setSkillsMode,
    skillIds,
    setSkillIds,
    skillOptions,
    hostSkillsMode,
    hostSkillIds,
    handleHostSkillsModeChange,
    handleHostSkillIdsChange,
    hostSkillOptions,
    skillsLoading,
    skillsError,
    hostSkillsSaving,
    runtimeCleanupRepairing,
    hostSkillsSaveStatus,
    handleRetryHostSkillSave,
    managedSkillsError,
    hostSkillsError,
    mcpMode,
    setMcpMode,
    mcpOptions,
    mcpIds,
    setMcpIds,
    mcpLoading,
    mcpError,
  } = props;

  return (
    <section
      id="agent-capabilities"
      hidden={draftMode && draftStep !== 4}
      className="scroll-mt-6 overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold text-foreground">能力配置</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          按来源配置 Skills。CKQClaw、宿主机与工作区能力会在运行时叠加；
          同名项以“最终生效能力”中的结果为准。
        </p>
      </div>
      <div className="space-y-5 px-5 py-5">
        <AgentSkillsPolicyEditor
          managedPolicy={{ mode: skillsMode, ids: skillIds }}
          onManagedModeChange={setSkillsMode}
          onManagedIdsChange={setSkillIds}
          managedOptions={skillOptions}
          hostPolicy={{
            mode: hostSkillsMode,
            ids: hostSkillIds,
          }}
          onHostModeChange={handleHostSkillsModeChange}
          onHostIdsChange={handleHostSkillIdsChange}
          hostOptions={hostSkillOptions}
          loading={skillsLoading}
          error={skillsError}
          hostAvailable
          hostAutoSave={!draftMode}
          hostSaving={hostSkillsSaving || runtimeCleanupRepairing}
          hostSaveStatus={hostSkillsSaveStatus}
          onRetryHostSave={handleRetryHostSkillSave}
          managedError={managedSkillsError}
          hostError={hostSkillsError}
        />

        <section className="min-w-0 space-y-2 border-t border-border pt-5">
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              CKQClaw MCP
            </h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              控制 CKQClaw 额外附加的 MCP；宿主机 MCP
              仍由上一步的宿主机配置控制。
            </p>
          </div>
          <div className="max-w-xl">
            <label className="block text-xs font-medium text-muted-foreground">
              使用方式
            </label>
            <Select
              value={mcpMode}
              onValueChange={(value) => setMcpMode(value as RuntimePolicyMode)}
            >
              <SelectTrigger aria-label="智能体 MCP">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">使用全部 CKQClaw MCP</SelectItem>
                <SelectItem value="custom">只允许所选 CKQClaw MCP</SelectItem>
                <SelectItem value="disabled">关闭 CKQClaw MCP</SelectItem>
              </SelectContent>
            </Select>
            {mcpMode === 'custom' && (
              <PolicyResourcePicker
                label="选择 CKQClaw MCP"
                options={mcpOptions}
                selectedIds={mcpIds}
                onChange={setMcpIds}
                loading={mcpLoading}
                error={mcpError}
                emptyText="没有已启用的 CKQClaw MCP"
              />
            )}
          </div>
        </section>

        <div className="border-t border-border pt-5">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">
              SDK 自动压缩
            </p>
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
              根据当前模型自动决定压缩时机。普通模型通常为 200K
              上下文；模型配置中声明的上下文窗口（如 1M）优先，历史 [1m]
              后缀仍按 1M 处理。历史百分比与 固定阈值配置已于 Pi
              运行时下线（存量值仅保留存储 兼容），实际压缩时机由运行时决定。
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
