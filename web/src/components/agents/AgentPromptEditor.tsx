import { useMemo, useState } from 'react';
import { Eye, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AGENT_PROMPT_SECTIONS,
  DEFAULT_AGENT_PROMPTS,
  composeAgentPrompt,
  estimatePromptTokens,
  totalPromptStats,
  type AgentPromptParts,
  type AgentPromptSection,
} from '@/utils/agent-prompts';

interface AgentPromptEditorProps {
  value: AgentPromptParts;
  onChange: (value: AgentPromptParts) => void;
  onOpenAssistant?: (section: AgentPromptSection) => void;
}

export function AgentPromptEditor({
  value,
  onChange,
  onOpenAssistant,
}: AgentPromptEditorProps) {
  const [activeSection, setActiveSection] =
    useState<AgentPromptSection>('identity');
  const [previewOpen, setPreviewOpen] = useState(false);
  const active =
    AGENT_PROMPT_SECTIONS.find((section) => section.key === activeSection) ??
    AGENT_PROMPT_SECTIONS[0];
  const stats = useMemo(() => totalPromptStats(value), [value]);
  const composed = useMemo(() => composeAgentPrompt(value), [value]);

  return (
    <section className="scroll-mt-6 overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">提示词</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            分别定义智能体的身份、人格、行为与工具规则，运行时按固定顺序组合。
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setPreviewOpen(true)}
        >
          <Eye className="size-3.5" />
          查看最终提示词
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            if (
              stats.completedSections > 0 &&
              !confirm('用推荐模板替换当前四段提示词？')
            )
              return;
            onChange(DEFAULT_AGENT_PROMPTS);
          }}
        >
          <Sparkles className="size-3.5" />
          一键填入推荐模板
        </Button>
      </div>

      <div className="space-y-5 px-5 py-5">
        <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
          <p className="text-xs font-medium text-foreground">系统提示词构成</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Pi 运行时的系统提示词由 CKQClaw
            运行规则（安全、记忆、渠道、输出契约）与下面四段提示词组成。Claude
            Code 默认提示词已随运行时迁移消失，历史的「追加 /
            替换」两种模式产物一致，故不再提供切换。
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-[190px_minmax(0,1fr)]">
          <div
            role="tablist"
            aria-label="智能体提示词分段"
            className="flex gap-2 overflow-x-auto pb-1 lg:block lg:space-y-1 lg:overflow-visible"
          >
            {AGENT_PROMPT_SECTIONS.map((section) => {
              const sectionValue = value[section.field];
              return (
                <button
                  key={section.key}
                  type="button"
                  role="tab"
                  aria-selected={section.key === activeSection}
                  onClick={() => setActiveSection(section.key)}
                  className={`min-w-[150px] rounded-lg px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:min-w-0 lg:w-full ${
                    section.key === activeSection
                      ? 'bg-brand-50 text-foreground ring-1 ring-inset ring-primary/15'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  }`}
                >
                  <span className="block text-[10px] font-semibold tracking-[0.12em] text-primary">
                    {section.eyebrow}
                  </span>
                  <span className="mt-0.5 block text-sm font-medium">
                    {section.title}
                  </span>
                  <span className="mt-0.5 block text-[10px] text-muted-foreground">
                    {sectionValue.length} 字符 · 约{' '}
                    {estimatePromptTokens(sectionValue)} tokens
                  </span>
                </button>
              );
            })}
          </div>

          <div role="tabpanel" className="min-w-0">
            <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
              <div>
                <label
                  htmlFor={`agent-prompt-${active.key}`}
                  className="text-sm font-medium text-foreground"
                >
                  {active.title}
                </label>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  {active.description}
                </p>
              </div>
              {onOpenAssistant && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onOpenAssistant(active.key)}
                >
                  <Sparkles className="size-3.5" />用 AI 优化这一段
                </Button>
              )}
            </div>
            <Textarea
              id={`agent-prompt-${active.key}`}
              value={value[active.field]}
              onChange={(event) =>
                onChange({ ...value, [active.field]: event.target.value })
              }
              className="min-h-[320px] resize-y text-sm leading-6"
              placeholder={active.placeholder}
            />
          </div>
        </div>

        <p className="text-[11px] text-muted-foreground" aria-live="polite">
          已填写 {stats.completedSections}/4 段 · {stats.characters} 字符 · 约{' '}
          {stats.estimatedTokens} tokens （估算）
        </p>
      </div>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-h-[85vh] sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>四段自定义提示词预览</DialogTitle>
            <DialogDescription>
              以下为四段自定义提示词。实际系统提示词还会前置 CKQClaw
              强制注入的安全、运行时和渠道规则；Pi 运行时没有 Claude Code
              默认提示词层。
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/20 p-4 text-xs leading-6 text-foreground">
            {composed || '尚未填写任何提示词。'}
          </pre>
        </DialogContent>
      </Dialog>
    </section>
  );
}
