import type { Dispatch, RefObject, SetStateAction } from 'react';
import { Loader2, RotateCcw, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { EmojiAvatar } from '@/components/common/EmojiAvatar';
import { EmojiPicker } from '@/components/common/EmojiPicker';
import { ColorPicker } from '@/components/common/ColorPicker';
import { AGENT_EFFORT_OPTIONS } from '@/utils/agent-runtime-policy-form';
import type { AgentContextSource, AgentEffortLevel } from '@/types';
import { useAgentProfilesStore } from '@/stores/agent-profiles';
import { useAuthStore } from '@/stores/auth';

// ISSUE-12 波 5 单元 5.7：身份区（名称/一句话身份、模型配置与推理档位、
// 头像四件套与宿主机配置开关）自 web/src/pages/AgentProfilesPage.tsx
// 原文搬运（原 782-1017）。JSX 逐字节一致；计划偏差留痕（同 5.5/5.9/
// 5.10）：handleAvatarUpload/handleInheritMainAvatar 留守页面经同名
// props 注入。

type Store = ReturnType<typeof useAgentProfilesStore.getState>;
type ModelConfigRow = Store['modelConfigs'];
type MainAppearance = ReturnType<typeof useAuthStore.getState>['appearance'];

export interface AgentIdentitySectionProps {
  draftMode: boolean;
  draftStep: number;
  isAdmin: boolean;
  mainAppearance: MainAppearance;
  name: string;
  setName: Dispatch<SetStateAction<string>>;
  modelConfigId: string;
  setModelConfigId: Dispatch<SetStateAction<string>>;
  modelConfigs: ModelConfigRow;
  defaultModelConfigId: string | null;
  effort: AgentEffortLevel;
  setEffort: Dispatch<SetStateAction<AgentEffortLevel>>;
  avatarUrl: string | null;
  avatarEmoji: string | null;
  setAvatarEmoji: Dispatch<SetStateAction<string | null>>;
  avatarColor: string | null;
  setAvatarColor: Dispatch<SetStateAction<string | null>>;
  uploadingAvatar: boolean;
  avatarStyleOpen: boolean;
  setAvatarStyleOpen: Dispatch<SetStateAction<boolean>>;
  avatarInputRef: RefObject<HTMLInputElement | null>;
  handleAvatarUpload: (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => void | Promise<void>;
  handleInheritMainAvatar: () => void | Promise<void>;
  contextSource: AgentContextSource;
  setContextSource: Dispatch<SetStateAction<AgentContextSource>>;
}

export function AgentIdentitySection(props: AgentIdentitySectionProps) {
  const {
    draftMode,
    draftStep,
    isAdmin,
    mainAppearance,
    name,
    setName,
    modelConfigId,
    setModelConfigId,
    modelConfigs,
    defaultModelConfigId,
    effort,
    setEffort,
    avatarUrl,
    avatarEmoji,
    setAvatarEmoji,
    avatarColor,
    setAvatarColor,
    uploadingAvatar,
    avatarStyleOpen,
    setAvatarStyleOpen,
    avatarInputRef,
    handleAvatarUpload,
    handleInheritMainAvatar,
    contextSource,
    setContextSource,
  } = props;

  return (
    <section
      hidden={draftMode && draftStep !== 1}
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold text-foreground">身份</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          定义这个智能体 如何称呼自己，以及它处理任务时遵循的角色设定。
        </p>
      </div>
      <div className="space-y-4 px-5 py-5">
        <div>
          <label
            htmlFor="agent-profile-name"
            className="mb-2 flex items-center gap-2 text-sm font-medium"
          >
            名称
          </label>
          <Input
            id="agent-profile-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div>
          <label className="mb-2 block text-sm font-medium">模型配置</label>
          <Select value={modelConfigId} onValueChange={setModelConfigId}>
            <SelectTrigger aria-label="智能体模型配置">
              <SelectValue placeholder="选择模型配置" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit">
                跟随系统默认
                {defaultModelConfigId
                  ? `（${modelConfigs.find((item) => item.id === defaultModelConfigId)?.name ?? '当前默认'}）`
                  : '（尚未配置）'}
              </SelectItem>
              {modelConfigs.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.name}
                  {model.anthropic_model ? ` · ${model.anthropic_model}` : ''}
                  {!model.enabled ? '（仅显式使用）' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
            该智能体所属的所有工作区、会话和定时任务都会使用这里解析出的完整模型网关环境。未启用的配置不会参与系统自动选择，但仍可由智能体显式使用。
          </p>
        </div>
        <div>
          <label className="mb-2 block text-sm font-medium">推理努力档位</label>
          <Select
            value={effort}
            onValueChange={(value) => setEffort(value as AgentEffortLevel)}
          >
            <SelectTrigger aria-label="智能体推理努力档位">
              <SelectValue placeholder="选择推理努力档位" />
            </SelectTrigger>
            <SelectContent>
              {AGENT_EFFORT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
            “跟随模型配置”保留 Provider 高级设置中的
            CLAUDE_CODE_EFFORT_LEVEL；显式档位通过 Agent SDK
            传入并覆盖该环境变量。不支持所选档位的模型会由 Claude
            静默降级，实际值可在会话的 CLAUDE_EFFORT 环境变量中查看。
          </p>
        </div>
        <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
          <div className="flex flex-wrap items-center gap-4">
            <EmojiAvatar
              imageUrl={
                avatarUrl ||
                (!avatarEmoji && !avatarColor
                  ? mainAppearance?.aiAvatarUrl ||
                    (mainAppearance?.aiAvatarMode !== 'emoji'
                      ? `${import.meta.env.BASE_URL}icons/icon-192.png`
                      : undefined)
                  : undefined)
              }
              emoji={
                avatarEmoji ||
                (!avatarUrl && !avatarColor
                  ? mainAppearance?.aiAvatarMode === 'emoji'
                    ? mainAppearance.aiAvatarEmoji
                    : undefined
                  : undefined)
              }
              color={
                avatarColor ||
                (!avatarUrl && !avatarEmoji
                  ? mainAppearance?.aiAvatarMode === 'emoji'
                    ? mainAppearance.aiAvatarColor
                    : undefined
                  : undefined)
              }
              fallbackChar={name || 'A'}
              size="lg"
              className="!h-12 !w-12 !text-xl"
            />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-foreground">
                智能体头像
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {avatarUrl || avatarEmoji || avatarColor
                  ? '当前使用这个智能体的自定义头像。'
                  : '未单独设置，自动继承主 CKQClaw 头像。'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                className="hidden"
                onChange={handleAvatarUpload}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={draftMode || uploadingAvatar}
                onClick={() => avatarInputRef.current?.click()}
              >
                {uploadingAvatar ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Upload className="size-3.5" />
                )}
                上传图片
              </Button>
              {!avatarStyleOpen && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setAvatarStyleOpen(true)}
                >
                  使用 Emoji
                </Button>
              )}
              {(avatarUrl || avatarEmoji || avatarColor) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={uploadingAvatar}
                  onClick={handleInheritMainAvatar}
                >
                  <RotateCcw className="size-3.5" />
                  使用主头像
                </Button>
              )}
            </div>
          </div>
          {avatarStyleOpen && (
            <div className="grid gap-3 border-t pt-3 sm:grid-cols-2">
              <div>
                <span className="mb-1.5 block text-xs text-muted-foreground">
                  Emoji（可选）
                </span>
                <EmojiPicker
                  value={avatarEmoji ?? undefined}
                  onChange={setAvatarEmoji}
                />
              </div>
              <div>
                <span className="mb-1.5 block text-xs text-muted-foreground">
                  背景色（可选）
                </span>
                <ColorPicker
                  value={avatarColor ?? undefined}
                  onChange={setAvatarColor}
                />
              </div>
            </div>
          )}
          {draftMode && (
            <p className="text-[11px] text-muted-foreground">
              创建智能体后即可上传图片；Emoji 与背景色会随创建一起保存。
            </p>
          )}
        </div>
        {isAdmin && !draftMode && (
          <div className="flex items-start justify-between gap-4 rounded-lg border bg-muted/20 px-3 py-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">
                加载完整宿主机 Claude Code 配置
              </div>
              <div className="mt-1 text-xs leading-5 text-muted-foreground">
                将 ~/.claude 作为用户配置层叠加，包含提示词、
                Rules、Agents、Commands、Hooks、Workflows、 Output Styles
                与设置（含宿主机 MCP）。工作区仍是 运行目录；CKQClaw MCP
                与宿主机 Skills 继续由“能力配置”独立控制。
              </div>
            </div>
            <Switch
              checked={contextSource === 'host_claude'}
              onCheckedChange={(checked) =>
                setContextSource(checked ? 'host_claude' : 'managed')
              }
              aria-label="加载完整宿主机 Claude Code 配置"
            />
          </div>
        )}
      </div>
    </section>
  );
}
