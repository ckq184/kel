import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Search } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  useModelPricingStore,
  type ModelPricingPreview,
  type ModelPricingRule,
} from '../../stores/model-pricing';

export type PricingDialogKind = 'pattern' | 'fallback';

interface ModelPricingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = create; editing keeps the original kind. */
  rule: ModelPricingRule | null;
  defaultKind: PricingDialogKind;
}

interface FormState {
  pattern: string;
  displayName: string;
  family: string;
  inputPrice: string;
  outputPrice: string;
  cacheReadPrice: string;
  cacheCreationPrice: string;
  reasoningPrice: string;
  enabled: boolean;
}

const INITIAL: FormState = {
  pattern: '',
  displayName: '',
  family: 'custom',
  inputPrice: '0',
  outputPrice: '0',
  cacheReadPrice: '0',
  cacheCreationPrice: '0',
  reasoningPrice: '0',
  enabled: true,
};

function ruleToForm(rule: ModelPricingRule): FormState {
  return {
    pattern: rule.pattern,
    displayName: rule.displayName,
    family: rule.family,
    inputPrice: String(rule.inputPricePerMTok),
    outputPrice: String(rule.outputPricePerMTok),
    cacheReadPrice: String(rule.cacheReadPricePerMTok),
    cacheCreationPrice: String(rule.cacheCreationPricePerMTok),
    reasoningPrice: String(rule.reasoningPricePerMTok),
    enabled: rule.enabled,
  };
}

const PRICE_FIELDS = [
  {
    key: 'inputPrice',
    label: '输入 /MTok (USD)',
    target: 'inputPricePerMTok',
  },
  {
    key: 'outputPrice',
    label: '输出 /MTok (USD)',
    target: 'outputPricePerMTok',
  },
  {
    key: 'cacheReadPrice',
    label: '缓存读 /MTok (USD)',
    target: 'cacheReadPricePerMTok',
  },
  {
    key: 'cacheCreationPrice',
    label: '缓存写 /MTok (USD)',
    target: 'cacheCreationPricePerMTok',
  },
  {
    key: 'reasoningPrice',
    label: '推理 /MTok (USD)',
    target: 'reasoningPricePerMTok',
  },
] as const;

const PREVIEW_SOURCE_LABELS: Record<ModelPricingPreview['source'], string> = {
  custom: '命中自定义规则',
  builtin: '命中内置价目表',
  'fallback-custom': '命中自定义兜底价',
  'fallback-sonnet': '未命中任何规则，使用内置 Sonnet 兜底',
};

export default function ModelPricingDialog({
  open,
  onOpenChange,
  rule,
  defaultKind,
}: ModelPricingDialogProps) {
  const { createRule, updateRule, preview } = useModelPricingStore();
  const [form, setForm] = useState<FormState>(INITIAL);
  const [submitting, setSubmitting] = useState(false);
  const [previewModel, setPreviewModel] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [previewResult, setPreviewResult] =
    useState<ModelPricingPreview | null>(null);
  const isEdit = rule !== null;
  const kind: PricingDialogKind = rule?.kind ?? defaultKind;

  useEffect(() => {
    if (open) {
      setForm(rule ? ruleToForm(rule) : INITIAL);
      setPreviewModel('');
      setPreviewResult(null);
    }
  }, [open, rule]);

  const set = <K extends keyof FormState>(key: K, val: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: val }));

  const handleSubmit = async () => {
    if (kind === 'pattern' && form.pattern.trim().length < 2) {
      toast.error('模式串至少 2 个字符');
      return;
    }
    const prices = Object.fromEntries(
      PRICE_FIELDS.map((field) => [
        field.target,
        form[field.key].trim() === '' ? 0 : Number(form[field.key]),
      ]),
    );
    for (const value of Object.values(prices)) {
      if (!Number.isFinite(value) || value < 0) {
        toast.error('单价必须是不小于 0 的数字');
        return;
      }
    }

    setSubmitting(true);
    try {
      if (isEdit) {
        await updateRule(rule.id, {
          ...(kind === 'pattern' ? { pattern: form.pattern.trim() } : {}),
          displayName: form.displayName.trim(),
          family: form.family.trim() || 'custom',
          ...prices,
          enabled: form.enabled,
        });
      } else {
        await createRule({
          kind,
          ...(kind === 'pattern' ? { pattern: form.pattern.trim() } : {}),
          displayName: form.displayName.trim(),
          family: form.family.trim() || 'custom',
          ...prices,
          enabled: form.enabled,
        });
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handlePreview = async () => {
    const model = previewModel.trim();
    if (!model) {
      toast.error('请输入要预览的模型名');
      return;
    }
    setPreviewing(true);
    try {
      const result = await preview(model);
      setPreviewResult(result);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? '编辑单价规则'
              : kind === 'fallback'
                ? '设置自定义兜底价'
                : '添加模型单价规则'}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {kind === 'pattern' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  模式串（子串匹配，大小写不敏感）
                </label>
                <Input
                  value={form.pattern}
                  onChange={(e) => set('pattern', e.target.value)}
                  placeholder="如 glm-5.3-flash"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  显示名称
                </label>
                <Input
                  value={form.displayName}
                  onChange={(e) => set('displayName', e.target.value)}
                  placeholder="如 GLM 5.3 Flash"
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            {PRICE_FIELDS.map((field) => (
              <div key={field.key}>
                <label className="block text-xs text-zinc-500 mb-1">
                  {field.label}
                </label>
                <Input
                  type="number"
                  step="0.001"
                  min="0"
                  value={form[field.key]}
                  onChange={(e) => set(field.key, e.target.value)}
                />
              </div>
            ))}
            <div className="flex items-center justify-between">
              <span className="text-sm">启用</span>
              <Switch
                checked={form.enabled}
                onCheckedChange={(v) => set('enabled', v)}
              />
            </div>
          </div>

          <div className="rounded-lg border border-border p-3">
            <div className="text-xs font-medium text-muted-foreground mb-2">
              预览匹配（基于已保存的规则，未保存的修改不参与）
            </div>
            <div className="flex items-center gap-2">
              <Input
                value={previewModel}
                onChange={(e) => setPreviewModel(e.target.value)}
                placeholder="输入完整模型名，如 zhipu/glm-5.3-flash"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handlePreview();
                }}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handlePreview}
                disabled={previewing}
              >
                <Search className="size-3.5" />
                预览匹配
              </Button>
            </div>
            {previewResult && (
              <div className="mt-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  {PREVIEW_SOURCE_LABELS[previewResult.source]}
                </span>
                {previewResult.pricing && (
                  <span>
                    ：
                    {previewResult.pricing.displayName ||
                      previewResult.pricing.pattern ||
                      '兜底'}
                  </span>
                )}
                {previewResult.pricing && (
                  <span className="ml-1">
                    （输入 ${previewResult.pricing.inputPricePerMTok} / 输出 $
                    {previewResult.pricing.outputPricePerMTok} /MTok）
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? '保存中...' : isEdit ? '保存' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
