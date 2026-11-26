import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  RotateCcw,
  X,
} from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '../../api/client';
import {
  CONTEXT_WINDOW_OPTIONS,
  buildDefaultProviderEnv,
  buildProviderModel,
  parseProviderModel,
  resolveProviderContextWindow,
  type ContextWindowPreset,
} from '../../utils/provider-model';
import {
  buildCustomEnv,
  DEFAULTED_THIRD_PARTY_ENV_KEYS,
  envRowsToText,
} from '../../utils/custom-env';
import {
  applyCustomHeaders,
  extractCustomHeaders,
  type HeaderRow,
} from '../../utils/custom-headers';
import type { ProviderWithHealth, EnvRow } from './types';
import { getErrorMessage } from './types';

const MANAGED_ENV_SOURCE_LABELS = {
  model: '跟随模型',
  context: '跟随上下文',
  default: '系统默认',
} as const;

/**
 * ISSUE-11 B5：EnvRow 行编辑器的序列化与校验严格化见 utils/custom-env.ts
 * （拍板 #7，存量已存数据不动）。
 */

interface ProviderEditorProps {
  open: boolean;
  /** null 表示创建模式 */
  provider: ProviderWithHealth | null;
  onSave: () => void;
  onCancel: () => void;
  setNotice: (msg: string | null) => void;
  setError: (msg: string | null) => void;
}

export function ProviderEditor({
  open,
  provider,
  onSave,
  onCancel,
  setNotice,
  setError,
}: ProviderEditorProps) {
  const isCreate = provider === null;

  // 基础字段
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  // 任务AL：窗口声明取代 [1m] 后缀开关（声明 > 启发式 > 200k）
  const [contextWindow, setContextWindow] =
    useState<ContextWindowPreset>('auto');

  // 第三方认证
  const [authToken, setAuthToken] = useState('');
  const [authTokenDirty, setAuthTokenDirty] = useState(false);
  const [clearTokenOnSave, setClearTokenOnSave] = useState(false);

  // 环境变量
  const [customEnvRows, setCustomEnvRows] = useState<EnvRow[]>([]);
  const [providerEnvOverrides, setProviderEnvOverrides] = useState<
    Record<string, string>
  >({});
  const [showCustomEnvValues, setShowCustomEnvValues] = useState<
    Record<number, boolean>
  >({});
  // ISSUE-24：第三方供应商的自定义请求头（存为 ANTHROPIC_CUSTOM_HEADERS）
  const [customHeaderRows, setCustomHeaderRows] = useState<HeaderRow[]>([]);
  const [showCustomHeaderValues, setShowCustomHeaderValues] = useState<
    Record<number, boolean>
  >({});

  // 状态
  const [saving, setSaving] = useState(false);

  const defaultProviderEnv = buildDefaultProviderEnv(model, contextWindow);

  // 初始化表单
  useEffect(() => {
    if (!open) return;
    setShowCustomEnvValues({});
    setShowCustomHeaderValues({});

    if (isCreate) {
      setName('');
      setBaseUrl('');
      setModel('');
      setContextWindow('auto');
      setAuthToken('');
      setAuthTokenDirty(false);
      setClearTokenOnSave(false);
      setCustomEnvRows([]);
      setCustomHeaderRows([]);
      setProviderEnvOverrides({});
    } else {
      setName(provider.name);
      setBaseUrl(provider.anthropicBaseUrl || '');
      const modelSelection = parseProviderModel(provider.anthropicModel || '');
      setModel(modelSelection.model);
      // 声明优先回显；无声明时存量 [1m] 后缀按 1M 兼容展示
      const initialContextWindow: ContextWindowPreset =
        provider.contextWindow && provider.contextWindow !== 'auto'
          ? provider.contextWindow
          : modelSelection.oneMillionContext
            ? 1_000_000
            : 'auto';
      setContextWindow(initialContextWindow);
      setAuthToken('');
      setAuthTokenDirty(false);
      setClearTokenOnSave(false);
      // ISSUE-24：第三方供应商的请求头迁入专用字段，不再出现在环境变量列表。
      const extracted = extractCustomHeaders(provider.customEnv || {});
      const providerCustomEnv = extracted.customEnv;
      setCustomHeaderRows(extracted.headerRows);
      const defaultEnv = Object.fromEntries(
        buildDefaultProviderEnv(modelSelection.model, initialContextWindow).map(
          (row) => [row.key, row.value],
        ),
      );
      const initialProviderEnvOverrides: Record<string, string> = {};
      for (const [key, value] of Object.entries(providerCustomEnv)) {
        if (
          DEFAULTED_THIRD_PARTY_ENV_KEYS.has(key) &&
          value !== defaultEnv[key]
        ) {
          initialProviderEnvOverrides[key] = value;
        }
      }
      setProviderEnvOverrides(initialProviderEnvOverrides);

      const envRows = Object.entries(providerCustomEnv)
        .filter(([key]) => !DEFAULTED_THIRD_PARTY_ENV_KEYS.has(key))
        .map(([key, value]) => ({ key, value }));
      setCustomEnvRows(envRows);
    }
  }, [open, isCreate, provider]);

  const addRow = () =>
    setCustomEnvRows((prev) => [...prev, { key: '', value: '' }]);
  const removeRow = (index: number) =>
    setCustomEnvRows((prev) => prev.filter((_, i) => i !== index));
  const updateRow = (index: number, field: keyof EnvRow, value: string) =>
    setCustomEnvRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );

  const addHeaderRow = () =>
    setCustomHeaderRows((prev) => [...prev, { name: '', value: '' }]);
  const removeHeaderRow = (index: number) =>
    setCustomHeaderRows((prev) => prev.filter((_, i) => i !== index));
  const updateHeaderRow = (
    index: number,
    field: keyof HeaderRow,
    value: string,
  ) =>
    setCustomHeaderRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );

  const updateProviderEnv = (
    key: string,
    value: string,
    defaultValue: string,
  ) => {
    setProviderEnvOverrides((current) => {
      const next = { ...current };
      if (value === defaultValue) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
  };

  const resetProviderEnv = (key: string) => {
    setProviderEnvOverrides((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  // ─── 保存 ──────────────────────────────────────────────────
  const handleSave = async () => {
    // 任务AL：模型名只剥离、永不追加 [1m]，窗口语义走独立 contextWindow 声明
    const normalizedModel = buildProviderModel(model);
    if (!normalizedModel) {
      setError('请填写第三方 API 支持的模型名称');
      return;
    }
    const trimmedName =
      name.trim() || parseProviderModel(normalizedModel).model;
    if (!trimmedName) {
      setError('请填写模型配置名称');
      return;
    }

    const trimmedBaseUrl = baseUrl.trim();
    if (!trimmedBaseUrl) {
      setError('请填写 API 端点');
      return;
    }

    const envResult = buildCustomEnv(envRowsToText(customEnvRows), {
      manageThirdPartyDefaults: true,
      manageCustomHeaders: true,
    });
    if (envResult.error) {
      setError(envResult.error);
      return;
    }
    let savedCustomEnv = {
      ...envResult.customEnv,
      ...providerEnvOverrides,
    };
    const headerResult = applyCustomHeaders(savedCustomEnv, customHeaderRows);
    if (headerResult.error) {
      setError(headerResult.error);
      return;
    }
    savedCustomEnv = headerResult.customEnv;

    setSaving(true);
    setError(null);

    try {
      if (isCreate) {
        // ── 创建模式 ──
        const trimmedToken = authToken.trim();
        if (!trimmedToken) {
          setError('新建第三方模型配置时必须填写 API 密钥');
          setSaving(false);
          return;
        }
        await api.post('/api/config/claude/providers', {
          name: trimmedName,
          type: 'third_party',
          customEnv: savedCustomEnv,
          anthropicBaseUrl: trimmedBaseUrl,
          anthropicAuthToken: trimmedToken,
          anthropicModel: normalizedModel,
          contextWindow,
        });
        setNotice('模型配置已创建。');
      } else {
        // ── 编辑模式 ──
        await api.patch(`/api/config/claude/providers/${provider!.id}`, {
          name: trimmedName,
          customEnv: savedCustomEnv,
          anthropicBaseUrl: trimmedBaseUrl,
          contextWindow,
          anthropicModel: normalizedModel,
        });

        // 更新密钥（如果有变更）
        const secretsBody: Record<string, unknown> = {};
        let hasSecretsChange = false;
        if (clearTokenOnSave) {
          secretsBody.clearAnthropicAuthToken = true;
          hasSecretsChange = true;
        } else if (authTokenDirty && authToken.trim()) {
          secretsBody.anthropicAuthToken = authToken.trim();
          hasSecretsChange = true;
        }

        if (hasSecretsChange) {
          await api.put(
            `/api/config/claude/providers/${provider!.id}/secrets`,
            secretsBody,
          );
        }

        setNotice('模型配置已保存。');
      }

      onSave();
    } catch (err) {
      setError(
        getErrorMessage(
          err,
          isCreate ? '创建模型配置失败' : '保存模型配置失败',
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    if (!saving) {
      onCancel();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="z-[10001] max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isCreate ? '添加模型配置' : `编辑模型配置：${provider?.name}`}
          </DialogTitle>
          <DialogDescription className="text-left text-xs leading-5">
            填写端点、密钥和模型即可；CKQClaw
            运行参数会自动预填，也可在高级设置中调整。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* 名称 */}
          <div>
            <label className="block text-xs text-muted-foreground mb-1">
              配置名称（可选）
            </label>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={saving}
              placeholder="留空时使用模型名称"
            />
          </div>

          {/* ─── 第三方模式 ─── */}
          <div className="space-y-5">
            <div>
              <label className="mb-1.5 flex items-center justify-between gap-3 text-xs font-medium text-foreground">
                <span>API 端点</span>
                <span className="font-normal text-muted-foreground">
                  ANTHROPIC_BASE_URL
                </span>
              </label>
              <Input
                type="url"
                inputMode="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                disabled={saving}
                placeholder="https://api.example.com/anthropic"
                autoComplete="off"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                填写 Anthropic 兼容接口的完整地址。
              </p>
            </div>

            <div>
              <label className="mb-1.5 flex items-center justify-between gap-3 text-xs font-medium text-foreground">
                <span>API 密钥</span>
                <span className="font-normal text-muted-foreground">
                  {!isCreate && provider?.hasAnthropicAuthToken
                    ? `当前 ${provider.anthropicAuthTokenMasked}`
                    : 'ANTHROPIC_AUTH_TOKEN'}
                </span>
              </label>
              <Input
                type="password"
                value={authToken}
                onChange={(e) => {
                  setAuthToken(e.target.value);
                  setAuthTokenDirty(true);
                  setClearTokenOnSave(false);
                }}
                disabled={saving || clearTokenOnSave}
                placeholder={
                  isCreate
                    ? '输入 API 密钥'
                    : provider?.hasAnthropicAuthToken
                      ? '留空保留当前密钥；输入新值覆盖'
                      : '输入 API 密钥'
                }
                autoComplete="new-password"
              />
              {!isCreate && provider?.hasAnthropicAuthToken && (
                <label className="mt-2 inline-flex min-h-8 items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={clearTokenOnSave}
                    onChange={(e) => {
                      setClearTokenOnSave(e.target.checked);
                      if (e.target.checked) {
                        setAuthToken('');
                        setAuthTokenDirty(false);
                      }
                    }}
                    disabled={saving}
                  />
                  保存时清空当前密钥
                </label>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_13rem] sm:items-end">
              <div className="min-w-0">
                <label className="mb-1.5 flex items-center justify-between gap-3 text-xs font-medium text-foreground">
                  <span>模型名称</span>
                  <span className="font-normal text-muted-foreground">
                    ANTHROPIC_MODEL
                  </span>
                </label>
                <Input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={saving}
                  placeholder="例如 glm-5.2、k3、qwen3.7-max"
                  autoComplete="off"
                />
              </div>

              <div className="flex min-h-16 flex-col justify-center gap-1.5 rounded-xl border border-border/80 bg-muted/35 px-3.5 py-2.5">
                <label
                  htmlFor="provider-context-window"
                  className="text-xs font-medium text-foreground"
                >
                  上下文窗口
                </label>
                <Select
                  value={String(contextWindow)}
                  onValueChange={(value) =>
                    setContextWindow(
                      value === 'auto'
                        ? 'auto'
                        : (Number(value) as ContextWindowPreset),
                    )
                  }
                  disabled={saving}
                >
                  <SelectTrigger
                    id="provider-context-window"
                    className="h-8 w-full text-xs"
                    aria-label="声明上下文窗口"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  {/* 弹窗内容层 z-[10001]（建仓基线遗产）高于 Select portal 默认 z-50，
                      下拉须抬到其上才可见 */}
                  <SelectContent className="z-[10002]">
                    {CONTEXT_WINDOW_OPTIONS.map((option) => (
                      <SelectItem
                        key={String(option.value)}
                        value={String(option.value)}
                        className="text-xs"
                      >
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <p className="mt-1.5 text-xs text-muted-foreground">
              上下文窗口请按模型真实支持的最大值选择；声明过大时上游会按其真实窗口截断或报超长。
              「自动」按 200K 处理，历史配置中的 [1m] 后缀仍按 1M 认定。
            </p>

            <div className="rounded-xl border border-primary/15 bg-primary/[0.035] px-3.5 py-3">
              <div className="flex items-start gap-2.5">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
                <div className="min-w-0">
                  <div className="text-xs font-medium text-foreground">
                    系统预填 CKQClaw 运行环境
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    实际模型：
                    <code className="break-all font-medium text-foreground">
                      {buildProviderModel(model) || '填写模型后生成'}
                    </code>
                    {' · '}
                    上下文窗口：
                    {resolveProviderContextWindow(
                      model,
                      contextWindow,
                    ).toLocaleString()}{' '}
                    tokens
                  </p>
                  <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                    默认同步模型映射、压缩窗口、请求超时与兼容参数；可在高级设置中调整。
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* ─── 环境变量 ─── */}
          <details className="border-t border-border pt-4">
            <summary className="cursor-pointer text-sm font-medium text-foreground">
              高级设置 · 环境变量
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {defaultProviderEnv.length} 项默认配置
              </span>
              {customEnvRows.length > 0 && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {customEnvRows.length} 项自定义
                </span>
              )}
              {customHeaderRows.length > 0 && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {customHeaderRows.length} 个请求头
                </span>
              )}
            </summary>

            <div className="mt-4 space-y-5">
              <section aria-labelledby="default-provider-env-heading">
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <h3
                      id="default-provider-env-heading"
                      className="text-xs font-medium text-foreground"
                    >
                      系统预填环境变量
                    </h3>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      默认值会随模型和上下文更新；修改后以你的自定义值为准。
                    </p>
                  </div>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                    {defaultProviderEnv.length} 项
                  </span>
                </div>

                <div className="overflow-hidden rounded-lg border border-border/80 bg-muted/20">
                  {defaultProviderEnv.map((row, index) => {
                    const hasOverride = Object.hasOwn(
                      providerEnvOverrides,
                      row.key,
                    );
                    const value = hasOverride
                      ? providerEnvOverrides[row.key]
                      : row.value;
                    const inputId = `provider-env-default-${index}`;

                    return (
                      <div
                        key={row.key}
                        className={`grid min-w-0 gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.8fr)] sm:items-center sm:gap-4 ${
                          index > 0 ? 'border-t border-border/70' : ''
                        }`}
                      >
                        <div className="flex min-w-0 items-center justify-between gap-2">
                          <label
                            htmlFor={inputId}
                            className="min-w-0 break-all font-mono text-[11px] text-foreground"
                          >
                            {row.key}
                          </label>
                          <span
                            className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] ${
                              hasOverride
                                ? 'border-primary/25 bg-primary/5 text-primary'
                                : 'border-border bg-background text-muted-foreground'
                            }`}
                          >
                            {hasOverride
                              ? '已自定义'
                              : MANAGED_ENV_SOURCE_LABELS[row.source]}
                          </span>
                        </div>
                        <div className="flex min-w-0 items-center gap-1.5">
                          <Input
                            id={inputId}
                            type="text"
                            value={value}
                            onChange={(event) =>
                              updateProviderEnv(
                                row.key,
                                event.target.value,
                                row.value,
                              )
                            }
                            disabled={saving}
                            placeholder="填写模型后生成"
                            autoComplete="off"
                            className="h-9 min-w-0 px-2.5 font-mono text-xs"
                          />
                          {hasOverride && (
                            <button
                              type="button"
                              onClick={() => resetProviderEnv(row.key)}
                              disabled={saving}
                              className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50 sm:size-9"
                              aria-label={`恢复 ${row.key} 的默认值`}
                              title="恢复默认值"
                            >
                              <RotateCcw className="size-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section
                aria-labelledby="custom-provider-headers-heading"
                className="border-t border-border pt-4"
              >
                <div className="mb-2 flex items-start justify-between gap-3">
                  <div>
                    <h3
                      id="custom-provider-headers-heading"
                      className="text-xs font-medium text-foreground"
                    >
                      自定义请求头
                    </h3>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      随每次模型请求发送的额外 HTTP
                      请求头，例如端点要求的会话头。
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={addHeaderRow}
                    className="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-xs text-primary hover:bg-muted"
                  >
                    <Plus className="size-3.5" />
                    添加
                  </button>
                </div>

                {customHeaderRows.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    没有自定义请求头。
                  </p>
                ) : (
                  <div className="space-y-2">
                    {customHeaderRows.map((row, idx) => (
                      <div
                        key={idx}
                        className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center"
                      >
                        <Input
                          type="text"
                          value={row.name}
                          onChange={(e) =>
                            updateHeaderRow(idx, 'name', e.target.value)
                          }
                          placeholder="Header-Name"
                          aria-label="请求头名称"
                          className="h-auto w-full px-2.5 py-1.5 font-mono text-xs sm:w-[38%]"
                        />
                        <Input
                          type={
                            showCustomHeaderValues[idx] ? 'text' : 'password'
                          }
                          value={row.value}
                          onChange={(e) =>
                            updateHeaderRow(idx, 'value', e.target.value)
                          }
                          placeholder="value"
                          aria-label="请求头的值"
                          className="h-auto flex-1 px-2.5 py-1.5 font-mono text-xs"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setShowCustomHeaderValues((current) => ({
                              ...current,
                              [idx]: !current[idx],
                            }))
                          }
                          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                          aria-label={
                            showCustomHeaderValues[idx]
                              ? '隐藏请求头的值'
                              : '显示请求头的值'
                          }
                        >
                          {showCustomHeaderValues[idx] ? (
                            <EyeOff className="size-4" />
                          ) : (
                            <Eye className="size-4" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => removeHeaderRow(idx)}
                          className="flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-red-500"
                          aria-label="删除请求头"
                        >
                          <X className="size-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section
                aria-labelledby="custom-provider-env-heading"
                className="border-t border-border pt-4"
              >
                <div className="mb-2 flex items-start justify-between gap-3">
                  <div>
                    <h3
                      id="custom-provider-env-heading"
                      className="text-xs font-medium text-foreground"
                    >
                      自定义环境变量
                    </h3>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      仅用于 API 自定义 Header 等特殊需求。
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={addRow}
                    className="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-xs text-primary hover:bg-muted"
                  >
                    <Plus className="size-3.5" />
                    添加
                  </button>
                </div>

                {customEnvRows.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    没有自定义环境变量，大多数配置无需添加。
                  </p>
                ) : (
                  <div className="space-y-2">
                    {customEnvRows.map((row, idx) => (
                      <div
                        key={idx}
                        className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center"
                      >
                        <Input
                          type="text"
                          value={row.key}
                          onChange={(e) =>
                            updateRow(idx, 'key', e.target.value)
                          }
                          placeholder="KEY"
                          className="h-auto w-full px-2.5 py-1.5 font-mono text-xs sm:w-[38%]"
                        />
                        <Input
                          type={showCustomEnvValues[idx] ? 'text' : 'password'}
                          value={row.value}
                          onChange={(e) =>
                            updateRow(idx, 'value', e.target.value)
                          }
                          placeholder="value"
                          className="h-auto flex-1 px-2.5 py-1.5 font-mono text-xs"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setShowCustomEnvValues((current) => ({
                              ...current,
                              [idx]: !current[idx],
                            }))
                          }
                          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                          aria-label={
                            showCustomEnvValues[idx]
                              ? '隐藏环境变量值'
                              : '显示环境变量值'
                          }
                        >
                          {showCustomEnvValues[idx] ? (
                            <EyeOff className="size-4" />
                          ) : (
                            <Eye className="size-4" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => removeRow(idx)}
                          className="flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-red-500"
                          aria-label="删除环境变量"
                        >
                          <X className="size-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </details>

          {/* ─── 操作按钮 ─── */}
          <div className="sticky -bottom-4 z-10 -mx-4 flex justify-end gap-2 border-t border-border bg-background/95 px-4 pb-4 pt-3 backdrop-blur supports-[backdrop-filter]:bg-background/85">
            <Button variant="outline" onClick={handleClose} disabled={saving}>
              取消
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {isCreate ? '创建' : '保存'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
