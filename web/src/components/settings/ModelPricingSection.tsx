import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Coins, Edit3, Plus, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { ConfirmDialog } from '../common/ConfirmDialog';
import {
  useModelPricingStore,
  type ModelPricingRule,
} from '../../stores/model-pricing';
import ModelPricingDialog from './ModelPricingDialog';

function priceSummary(rule: ModelPricingRule): string {
  return [
    rule.inputPricePerMTok,
    rule.outputPricePerMTok,
    rule.cacheReadPricePerMTok,
    rule.cacheCreationPricePerMTok,
    rule.reasoningPricePerMTok,
  ]
    .map((price) => `$${price}`)
    .join(' / ');
}

interface RuleRowProps {
  rule: ModelPricingRule;
  onEdit: () => void;
  onDelete: () => void;
}

function RuleRow({ rule, onEdit, onDelete }: RuleRowProps) {
  const [toggling, setToggling] = useState(false);
  const handleToggle = async (enabled: boolean) => {
    setToggling(true);
    try {
      await useModelPricingStore.getState().updateRule(rule.id, { enabled });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setToggling(false);
    }
  };

  return (
    <div
      className={`px-4 py-3 transition-colors ${
        !rule.enabled ? 'bg-muted/50 opacity-60' : ''
      }`}
    >
      <div className="flex items-center gap-2 justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-sm text-foreground truncate">
            {rule.pattern}
          </span>
          {rule.displayName && (
            <span className="text-xs text-muted-foreground truncate">
              {rule.displayName}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Switch
            checked={rule.enabled}
            disabled={toggling}
            onCheckedChange={handleToggle}
            aria-label={rule.enabled ? '停用规则' : '启用规则'}
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={onEdit}
            disabled={toggling}
            className="h-7 px-2 text-xs"
          >
            <Edit3 className="size-3.5" />
            编辑
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onDelete}
            disabled={toggling}
            className="h-7 px-2 text-xs text-destructive hover:text-destructive"
          >
            删除
          </Button>
        </div>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        输入/输出/缓存读/缓存写/推理：{priceSummary(rule)} /MTok
      </div>
    </div>
  );
}

export function ModelPricingSection() {
  const { rules, fallback, loading, error, loadRules } = useModelPricingStore();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<ModelPricingRule | null>(null);
  const [dialogKind, setDialogKind] = useState<'pattern' | 'fallback'>(
    'pattern',
  );
  const [deleting, setDeleting] = useState<ModelPricingRule | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  const openCreate = (kind: 'pattern' | 'fallback') => {
    setEditingRule(null);
    setDialogKind(kind);
    setDialogOpen(true);
  };

  const openEdit = (rule: ModelPricingRule) => {
    setEditingRule(rule);
    setDialogKind(rule.kind);
    setDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await useModelPricingStore.getState().deleteRule(deleting.id);
      setDeleting(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          {error}
        </div>
      )}
      {loading && (
        <div className="text-sm text-muted-foreground">加载单价规则中…</div>
      )}

      {/* 兜底价卡片 */}
      <div className="rounded-xl border border-border overflow-hidden">
        <div className="px-4 py-3 border-b border-border bg-muted/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Coins className="size-4 text-primary" />
              兜底价
            </div>
            {!fallback && (
              <Button size="sm" onClick={() => openCreate('fallback')}>
                <Plus className="size-3.5" />
                设置兜底价
              </Button>
            )}
          </div>
        </div>
        {fallback ? (
          <RuleRow
            rule={fallback}
            onEdit={() => openEdit(fallback)}
            onDelete={() => setDeleting(fallback)}
          />
        ) : (
          <div className="p-4 text-sm text-muted-foreground">
            未设置（内置 Sonnet 兜底 $3 输入 / $15 输出 /MTok 生效）。未命中任何
            自定义规则与内置价目表的模型将按该兜底价计费。
          </div>
        )}
      </div>

      {/* 规则列表卡片 */}
      <div className="rounded-xl border border-border overflow-hidden">
        <div className="px-4 py-3 border-b border-border bg-muted/50">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-foreground">
              模型单价规则
            </div>
            <span className="text-xs text-muted-foreground">
              {rules.length} 条规则
            </span>
          </div>
        </div>
        {rules.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            暂无单价规则，请点击下方按钮添加。
          </div>
        ) : (
          <div className="divide-y divide-border">
            {rules.map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                onEdit={() => openEdit(rule)}
                onDelete={() => setDeleting(rule)}
              />
            ))}
          </div>
        )}
        <div className="border-t border-border p-3">
          <Button
            variant="outline"
            className="w-full"
            onClick={() => openCreate('pattern')}
          >
            <Plus className="size-4" />
            添加模型单价规则
          </Button>
        </div>
      </div>

      <p className="text-xs leading-5 text-muted-foreground">
        新事件的计价优先级：自定义规则（最长匹配）→ 内置价目表 → 自定义兜底 →
        内置 Sonnet 兜底。规则变更只影响之后的新事件，历史用量金额不变。
      </p>

      <ModelPricingDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        rule={editingRule}
        defaultKind={dialogKind}
      />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        title="删除单价规则"
        message={`确定删除「${
          deleting?.kind === 'fallback' ? '兜底价' : deleting?.pattern
        }」吗？删除后新事件立即回落到内置价目表或兜底价，历史金额不受影响。`}
        confirmVariant="danger"
        loading={deleteBusy}
      />
    </div>
  );
}
