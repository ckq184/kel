import { AGENT_EFFORT_OPTIONS } from '@/utils/agent-runtime-policy-form';
import { skillPolicySummary } from '@/utils/agent-runtime-policy';
import type { AgentPromptParts } from '@/utils/agent-prompts';
import type { AgentContextSource, AgentEffortLevel } from '@/types';
import type { RuntimePolicyMode } from '@/utils/agent-runtime-policy';
import { useAgentProfilesStore } from '@/stores/agent-profiles';

// ISSUE-12 波 5 单元 5.6：草稿确认汇总（SummaryItem 与 draftStep===5 的
// 确认创建 section）自 web/src/pages/AgentProfilesPage.tsx 原文搬运（原
// 85-93 与 1216-1302）。JSX 与 SummaryItem 逐字节一致；15 项表单/策略值
// 经 props 注入（store 推导类型收窄）。

type ModelConfigRow = ReturnType<
  typeof useAgentProfilesStore.getState
>['modelConfigs'];

export interface AgentDraftSummaryProps {
  name: string;
  currentPrompts: AgentPromptParts;
  modelConfigId: string;
  defaultModelConfigId: string | null;
  modelConfigs: ModelConfigRow;
  effort: AgentEffortLevel;
  contextSource: AgentContextSource;
  skillsMode: RuntimePolicyMode;
  skillIds: string[];
  hostSkillsMode: RuntimePolicyMode;
  hostSkillIds: string[];
  mcpMode: RuntimePolicyMode;
  mcpIds: string[];
  capabilityError: string | null;
}
function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/50 p-3">
      <dt className="text-[11px] font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-foreground">{value}</dd>
    </div>
  );
}

export function AgentDraftSummary(props: AgentDraftSummaryProps) {
  const {
    name,
    currentPrompts,
    modelConfigId,
    defaultModelConfigId,
    modelConfigs,
    effort,
    contextSource,
    skillsMode,
    skillIds,
    hostSkillsMode,
    hostSkillIds,
    mcpMode,
    mcpIds,
    capabilityError,
  } = props;

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="border-b px-5 py-4">
        <h2 className="text-sm font-semibold">确认创建</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          检查核心设置。创建后仍可随时修改并通过版本历史回退提示词。
        </p>
      </div>
      <dl className="grid gap-4 p-5 sm:grid-cols-2">
        <SummaryItem label="名称" value={name.trim() || '未填写'} />
        <SummaryItem
          label="提示词完成度"
          value={`${Object.values(currentPrompts).filter((value) => value.trim()).length}/4 段`}
        />
        <SummaryItem
          label="模型配置"
          value={
            modelConfigId === 'inherit'
              ? `跟随系统默认${defaultModelConfigId ? `：${modelConfigs.find((item) => item.id === defaultModelConfigId)?.name ?? '当前默认'}` : ''}`
              : (modelConfigs.find((item) => item.id === modelConfigId)?.name ??
                '不可用模型配置')
          }
        />
        <SummaryItem
          label="推理努力档位"
          value={
            AGENT_EFFORT_OPTIONS.find((option) => option.value === effort)
              ?.label ?? '跟随模型配置'
          }
        />
        <SummaryItem
          label="宿主机配置"
          value={
            contextSource === 'host_claude'
              ? '完整加载 ~/.claude（宿主机 Skills 独立）'
              : '不加载'
          }
        />
        <SummaryItem
          label="CKQClaw Skills"
          value={
            skillsMode === 'inherit'
              ? '全部已启用'
              : skillsMode === 'disabled'
                ? '关闭'
                : `所选 ${skillIds.length} 项`
          }
        />
        <SummaryItem
          label="宿主机 Skills"
          value={skillPolicySummary(
            { mode: hostSkillsMode, ids: hostSkillIds },
            '全部使用',
          )}
        />
        <SummaryItem
          label="CKQClaw MCP"
          value={
            mcpMode === 'inherit'
              ? '全部已启用'
              : mcpMode === 'disabled'
                ? '关闭'
                : `所选 ${mcpIds.length} 项`
          }
        />
      </dl>
      {!name.trim() && (
        <p
          role="alert"
          className="mx-5 mb-5 rounded-lg bg-error-bg px-3 py-2 text-xs text-error"
        >
          请返回“基本信息”填写名称。
        </p>
      )}
      {capabilityError && (
        <p
          role="alert"
          className="mx-5 mb-5 rounded-lg bg-error-bg px-3 py-2 text-xs text-error"
        >
          {capabilityError}
        </p>
      )}
    </section>
  );
}
