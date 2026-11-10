import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { BrainCircuit, Loader2, Trash2, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '../common/ConfirmDialog';
import {
  useAutoMemoryStore,
  type AutoMemoryEndpointView,
} from '../../stores/auto-memory';

/**
 * 自动记忆端点配置卡（任务 X）——挂在「模型配置（claude）」tab。
 *
 * 三态：未配置（空表单）/ 已配置·文件（掩码预填，apiKey 留空或掩码不动 =
 * 保留现有密钥）/ 被环境变量 CKQCLAW_AUTO_MEMORY 覆盖（只读提示，表单禁用）。
 * 保存与清除成功后服务端会停止全部运行中侧车，下次使用时以新配置 respawn。
 * 全部 API 调用经 useAutoMemoryStore，本组件不直连。
 */

interface EndpointFormValue {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const EMPTY_FORM: EndpointFormValue = { baseUrl: '', apiKey: '', model: '' };

/** 掩码视图 → 表单预填；缺侧端点时给空表单。 */
function endpointForm(view?: AutoMemoryEndpointView): EndpointFormValue {
  if (!view) return { ...EMPTY_FORM };
  return {
    baseUrl: view.baseUrl,
    apiKey: view.apiKeyMasked,
    model: view.model,
  };
}

export function AutoMemoryEndpointCard() {
  const {
    config,
    configLoading,
    configError,
    actionError,
    loadConfig,
    saveConfig,
    clearConfig,
  } = useAutoMemoryStore();
  const navigate = useNavigate();

  const [llm, setLlm] = useState<EndpointFormValue>(EMPTY_FORM);
  const [embedder, setEmbedder] = useState<EndpointFormValue>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  // 掩码预填：仅在新配置落地时重置表单，避免覆盖正在编辑的输入。
  const [prefilledFrom, setPrefilledFrom] = useState<unknown>(null);
  useEffect(() => {
    if (!config || config.source === 'none') return;
    if (prefilledFrom === config) return;
    setLlm(endpointForm(config.llm));
    setEmbedder(endpointForm(config.embedder));
    setPrefilledFrom(config);
  }, [config, prefilledFrom]);

  const envOverride = config?.source === 'env';
  const formDisabled = envOverride || saving;

  const handleSave = async () => {
    if (!llm.baseUrl || !llm.model || !embedder.baseUrl || !embedder.model) {
      toast.error('llm 与 embedder 两侧都需要填写 baseUrl 与 model');
      return;
    }
    setSaving(true);
    try {
      await saveConfig({ llm, embedder });
      toast.success('已停止全部自动记忆侧车，下次使用时以新配置启动');
    } catch {
      // actionError 已由 store 记录，卡片内联展示。
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setClearBusy(true);
    try {
      await clearConfig();
      toast.success('已清除端点配置，并停止全部自动记忆侧车');
      setClearOpen(false);
    } catch {
      // actionError 已由 store 记录，卡片内联展示。
    } finally {
      setClearBusy(false);
    }
  };

  return (
    <section
      data-auto-memory-endpoint-card="true"
      className="rounded-xl border border-border bg-background"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/50 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <BrainCircuit className="size-4 text-primary" />
          自动记忆端点
        </div>
        {config?.source === 'file' && config.enabled && (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => setClearOpen(true)}
            disabled={formDisabled}
          >
            <Trash2 className="size-3.5" />
            清除配置
          </Button>
        )}
      </div>

      <div className="space-y-4 px-4 py-4">
        <p className="text-sm leading-6 text-muted-foreground">
          自动记忆由宿主机 mem0 侧车提供，需要成对的 llm 与 embedder OpenAI
          兼容端点（baseUrl / apiKey / model）。配置写入本机文件
          （0o600），端点只用于宿主侧车，不会透传给任何 Agent 容器。
        </p>

        {configLoading && !config ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在获取端点配置…
          </div>
        ) : configError ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              {configError}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void loadConfig()}
            >
              重试
            </Button>
          </div>
        ) : envOverride ? (
          <div className="flex items-start gap-2 rounded-xl border border-warning/20 bg-warning-bg px-4 py-3 text-sm text-warning">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0">
              <div className="font-medium">被环境变量覆盖，文件配置不可用</div>
              <div className="mt-1 text-xs opacity-80">
                宿主机已设置{' '}
                <code className="rounded bg-muted px-1 font-mono">
                  CKQCLAW_AUTO_MEMORY
                </code>
                ，端点由环境变量通道提供且优先级更高。请在宿主机调整环境变量；清除它之前此表单保持只读。
              </div>
            </div>
          </div>
        ) : null}

        <div className="space-y-4">
          <EndpointFields
            label="llm（事实抽取端点）"
            value={llm}
            onChange={setLlm}
            disabled={formDisabled}
          />
          <EndpointFields
            label="embedder（向量化端点）"
            value={embedder}
            onChange={setEmbedder}
            disabled={formDisabled}
          />
          <p className="text-xs leading-5 text-muted-foreground">
            apiKey
            留空或保持掩码原样表示保留现有密钥；输入新值才会覆盖。保存后会停止全部运行中的自动记忆侧车，下次使用时以新配置启动。
          </p>
          {actionError && (
            <div className="flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              {actionError}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={handleSave} disabled={formDisabled}>
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              保存端点配置
            </Button>
            {config?.source === 'none' && (
              <span className="text-xs text-muted-foreground">
                保存后可在
                <button
                  type="button"
                  className="mx-1 text-primary underline-offset-2 hover:underline"
                  onClick={() => navigate('/settings?tab=auto-memory')}
                >
                  「自动记忆」
                </button>
                分区查看启用状态。
              </span>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        onConfirm={handleClear}
        title="清除自动记忆端点配置？"
        message="将删除文件中的 llm 与 embedder 端点配置（不含已保存的记忆数据），并停止全部自动记忆侧车。该操作立即生效。"
        confirmText="清除配置"
        confirmVariant="danger"
        loading={clearBusy}
      />
    </section>
  );
}

function EndpointFields({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: EndpointFormValue;
  onChange: (value: EndpointFormValue) => void;
  disabled: boolean;
}) {
  const inputClass =
    'h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-60';
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium text-foreground">{label}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-xs text-muted-foreground">
            Base URL（http/https）
          </span>
          <input
            value={value.baseUrl}
            onChange={(event) =>
              onChange({ ...value, baseUrl: event.target.value })
            }
            placeholder="https://api.example.com/v1"
            className={inputClass}
            autoComplete="off"
            disabled={disabled}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">
            API Key
          </span>
          <input
            value={value.apiKey}
            onChange={(event) =>
              onChange({ ...value, apiKey: event.target.value })
            }
            placeholder="留空保留现有密钥"
            className={inputClass}
            autoComplete="off"
            disabled={disabled}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">
            模型名
          </span>
          <input
            value={value.model}
            onChange={(event) =>
              onChange({ ...value, model: event.target.value })
            }
            placeholder="例如 gpt-4o-mini / text-embedding-3-small"
            className={inputClass}
            autoComplete="off"
            disabled={disabled}
          />
        </label>
      </div>
    </fieldset>
  );
}
