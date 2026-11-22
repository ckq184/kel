import { Loader2, Plus, Wand2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

// ISSUE-12 波 5 单元 5.5：新建面板 section（AI 生成/空白创建双入口、示例
// 填充与智能体角色描述输入）自 web/src/pages/AgentProfilesPage.tsx 原文
// 搬运（原 782-883）。JSX 逐字节一致；计划偏差留痕：handleGenerateDraft/
// handleBlankDraft 留守页面（触 15 项页面级状态），经回调 props 注入。

export interface AgentCreatePanelProps {
  createDescription: string;
  setCreateDescription: (value: string) => void;
  generatingDraft: boolean;
  onClose: () => void;
  handleGenerateDraft: () => void | Promise<void>;
  handleBlankDraft: () => void;
}

export function AgentCreatePanel(props: AgentCreatePanelProps) {
  const {
    createDescription,
    setCreateDescription,
    generatingDraft,
    onClose,
    handleGenerateDraft,
    handleBlankDraft,
  } = props;

  return (
    <section
      className="min-h-[calc(100dvh-8rem)]"
      aria-labelledby="create-agent-title"
    >
      <header className="flex flex-col gap-5 border-b border-border pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-2xl">
          <div className="mb-3 inline-flex items-center gap-2 text-sm font-medium text-primary">
            <Wand2 className="h-4 w-4" />
            新建自定义智能体
          </div>
          <h1
            id="create-agent-title"
            className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl"
          >
            先说说它要帮你做什么
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">
            描述角色、任务和关注重点，AI
            会生成一份可继续编辑的完整配置；你也可以直接从空白配置开始。
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 self-start"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
          返回智能体
        </Button>
      </header>

      <div className="max-w-3xl py-8 sm:py-10">
        <label
          htmlFor="new-agent-description"
          className="text-sm font-semibold text-foreground"
        >
          智能体角色描述
        </label>
        <p
          id="new-agent-description-help"
          className="mt-1 text-sm leading-6 text-muted-foreground"
        >
          写清楚主要任务、输出方式或需要特别关注的事项，生成结果会更贴合预期。
        </p>
        <Textarea
          id="new-agent-description"
          aria-describedby="new-agent-description-help"
          autoFocus
          value={createDescription}
          onChange={(event) => setCreateDescription(event.target.value)}
          className="mt-4 min-h-[180px] resize-y bg-card p-4 text-base leading-7 shadow-sm"
          placeholder="例如：帮我做代码评审，重点关注架构风险、并发问题和测试缺口。输出时先给结论，再按严重程度列出问题和修改建议。"
        />

        <div className="mt-5">
          <div className="text-xs font-medium text-muted-foreground">
            可以从这些例子开始
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {[
              '做代码评审，关注架构风险和测试缺口',
              '整理调研资料，给出有依据的结论和来源',
              '把产品想法拆成清晰、可执行的研发任务',
            ].map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setCreateDescription(example)}
                className="min-h-11 rounded-full border border-border bg-background px-4 py-2 text-left text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {example}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-8 flex flex-col gap-3 border-t border-border pt-6 sm:flex-row">
          <Button
            size="lg"
            className="min-h-11 justify-center sm:min-w-40"
            onClick={handleGenerateDraft}
            disabled={generatingDraft || !createDescription.trim()}
          >
            {generatingDraft ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Wand2 className="h-4 w-4" />
            )}
            AI 生成配置
          </Button>
          <Button
            size="lg"
            variant="outline"
            className="min-h-11 justify-center sm:min-w-40"
            onClick={handleBlankDraft}
          >
            <Plus className="h-4 w-4" />
            空白创建
          </Button>
        </div>
      </div>
    </section>
  );
}
