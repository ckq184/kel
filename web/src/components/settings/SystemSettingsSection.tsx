import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowRight, Loader2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '../../api/client';
import { useAuthStore } from '../../stores/auth';
import { useChatStore } from '../../stores/chat';
import { useTasksStore } from '../../stores/tasks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { HostIntegrationSettings, SystemSettings } from './types';
import { getErrorMessage } from './types';

type NumericSettingKey =
  | 'containerTimeout'
  | 'idleTimeout'
  | 'containerMaxOutputSize'
  | 'maxConcurrentContainers';

interface FieldConfig {
  key: NumericSettingKey;
  label: string;
  description: string;
  unit: string;
  toDisplay: (value: number) => number;
  toStored: (value: number) => number;
  min: number;
  max: number;
  step: number;
  validate?: (value: number) => string | null;
}

interface FieldGroup {
  title: string;
  description: string;
  fields: FieldConfig[];
}

const fieldGroups: FieldGroup[] = [
  {
    title: '运行资源',
    description:
      'Docker 容器使用显式容量上限；宿主机模式仅对同一会话串行，不限制不同会话并发。正在运行的任务不会被中断。',
    fields: [
      {
        key: 'containerTimeout',
        label: '默认任务最大运行时间',
        description:
          '容器或宿主机进程单次运行的默认最长时间；工作区可单独覆盖。',
        unit: '分钟',
        toDisplay: (value) => Math.round(value / 60_000),
        toStored: (value) => value * 60_000,
        min: 1,
        max: 1440,
        step: 1,
      },
      {
        key: 'idleTimeout',
        label: '工作区运行器空闲保留时间',
        description:
          '最后一次输出后持续无活动，达到该时长时关闭容器或宿主机运行进程。',
        unit: '分钟',
        toDisplay: (value) => Math.round(value / 60_000),
        toStored: (value) => value * 60_000,
        min: 1,
        max: 1440,
        step: 1,
      },
      {
        key: 'containerMaxOutputSize',
        label: '运行日志保留上限',
        description:
          '限制单次运行保留的 stdout/stderr 日志，不限制智能体回复长度。',
        unit: 'MB',
        toDisplay: (value) => Math.round(value / 1_048_576),
        toStored: (value) => value * 1_048_576,
        min: 1,
        max: 100,
        step: 1,
      },
      {
        key: 'maxConcurrentContainers',
        label: 'Docker 容器并发上限',
        description: '系统同时运行的 Docker 容器数量上限。',
        unit: '个',
        toDisplay: (value) => value,
        toStored: (value) => value,
        min: 1,
        max: 100,
        step: 1,
      },
    ],
  },
];

const fields = fieldGroups.flatMap((group) => group.fields);

function toDisplayValues(
  settings: SystemSettings,
): Record<NumericSettingKey, string> {
  return Object.fromEntries(
    fields.map((field) => [
      field.key,
      String(field.toDisplay(settings[field.key])),
    ]),
  ) as Record<NumericSettingKey, string>;
}

function getFieldError(field: FieldConfig, rawValue: string): string | null {
  if (!rawValue.trim()) return '请输入一个数值。';
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return '请输入有效数字。';
  if (!Number.isInteger(value / field.step)) {
    return `请输入 ${field.step} 的整数倍。`;
  }
  if (value < field.min || value > field.max) {
    return `请输入 ${field.min}–${field.max} ${field.unit}。`;
  }
  return field.validate?.(value) ?? null;
}

function RetryState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-6 text-center">
      <AlertCircle className="size-6 text-destructive" aria-hidden="true" />
      <div>
        <p className="text-sm font-medium text-foreground">加载失败</p>
        <p className="mt-1 text-xs text-muted-foreground">{message}</p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onRetry}
        className="min-h-11"
      >
        <RotateCcw className="size-4" aria-hidden="true" />
        重新加载
      </Button>
    </div>
  );
}

function NumberSettingField({
  field,
  value,
  error,
  onChange,
  onBlur,
}: {
  field: FieldConfig;
  value: string;
  error: string | null;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  const inputId = `system-setting-${field.key}`;
  const descriptionId = `${inputId}-description`;
  const errorId = `${inputId}-error`;

  return (
    <div className="grid gap-2 py-4 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_11rem] sm:gap-8">
      <div className="min-w-0">
        <Label htmlFor={inputId} className="text-sm font-medium">
          {field.label}
        </Label>
        <p
          id={descriptionId}
          className="mt-1 text-xs leading-5 text-muted-foreground"
        >
          {field.description}
        </p>
      </div>
      <div className="self-start">
        <div className="flex items-center gap-2">
          <Input
            id={inputId}
            type="number"
            inputMode="numeric"
            value={value}
            min={field.min}
            max={field.max}
            step={field.step}
            onChange={(event) => onChange(event.target.value)}
            onBlur={onBlur}
            aria-invalid={!!error}
            aria-describedby={`${descriptionId}${error ? ` ${errorId}` : ''}`}
            className="h-11 min-w-0"
          />
          <span className="w-16 shrink-0 text-xs text-muted-foreground">
            {field.unit}
          </span>
        </div>
        {error && (
          <p
            id={errorId}
            role="alert"
            className="mt-1.5 text-xs text-destructive"
          >
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

export function SystemSettingsSection() {
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [values, setValues] = useState<Record<
    NumericSettingKey,
    string
  > | null>(null);
  const [initialValues, setInitialValues] = useState<Record<
    NumericSettingKey,
    string
  > | null>(null);
  const [touched, setTouched] = useState<
    Partial<Record<NumericSettingKey, boolean>>
  >({});
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.get<SystemSettings>('/api/config/system');
      const nextValues = toDisplayValues(data);
      setSettings(data);
      setValues(nextValues);
      setInitialValues(nextValues);
      setTouched({});
      setSubmitted(false);
    } catch (error) {
      setLoadError(
        getErrorMessage(error, '无法读取系统参数，请检查网络后重试。'),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const errors = useMemo(() => {
    if (!values) return {} as Partial<Record<NumericSettingKey, string>>;
    return Object.fromEntries(
      fields
        .map((field) => [field.key, getFieldError(field, values[field.key])])
        .filter((entry) => entry[1]),
    ) as Partial<Record<NumericSettingKey, string>>;
  }, [values]);

  const dirty = useMemo(
    () =>
      !!values &&
      !!initialValues &&
      fields.some((field) => values[field.key] !== initialValues[field.key]),
    [initialValues, values],
  );

  const handleSave = async () => {
    if (!settings || !values) return;
    setSubmitted(true);
    if (Object.keys(errors).length > 0) return;

    const payload: Partial<SystemSettings> = {};
    for (const field of fields) {
      payload[field.key] = field.toStored(Number(values[field.key]));
    }

    setSaving(true);
    try {
      const data = await api.put<SystemSettings>('/api/config/system', payload);
      const nextValues = toDisplayValues(data);
      setSettings(data);
      setValues(nextValues);
      setInitialValues(nextValues);
      setTouched({});
      setSubmitted(false);
      toast.success('系统参数已保存，将应用于后续启动的任务');
    } catch (error) {
      toast.error(getErrorMessage(error, '系统参数保存失败，请稍后重试。'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div
        className="flex min-h-40 items-center justify-center"
        aria-label="正在加载系统参数"
      >
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (loadError || !values) {
    return (
      <RetryState
        message={loadError ?? '系统参数不可用。'}
        onRetry={() => void loadSettings()}
      />
    );
  }

  return (
    <div>
      <p className="text-sm leading-6 text-muted-foreground">
        管理工作区运行边界、日志和执行容量。
      </p>

      <div className="mt-6 divide-y divide-border">
        {fieldGroups.map((group) => (
          <section key={group.title} className="py-6 first:pt-0">
            <header className="mb-5 max-w-2xl">
              <h2 className="text-base font-semibold text-foreground">
                {group.title}
              </h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {group.description}
              </p>
            </header>
            <div className="divide-y divide-border/70">
              {group.fields.map((field) => (
                <NumberSettingField
                  key={field.key}
                  field={field}
                  value={values[field.key]}
                  error={
                    submitted || touched[field.key]
                      ? (errors[field.key] ?? null)
                      : null
                  }
                  onChange={(value) =>
                    setValues((current) =>
                      current ? { ...current, [field.key]: value } : current,
                    )
                  }
                  onBlur={() =>
                    setTouched((current) => ({ ...current, [field.key]: true }))
                  }
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      <div className="sticky bottom-0 z-10 -mx-4 mt-2 flex min-h-16 items-center justify-between gap-4 border-t border-border bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/85">
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {dirty ? '有尚未保存的系统参数' : '系统参数已保存'}
        </p>
        <Button
          onClick={() => void handleSave()}
          disabled={saving || !dirty || Object.keys(errors).length > 0}
          className="min-h-11"
        >
          {saving && (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          )}
          保存系统参数
        </Button>
      </div>
    </div>
  );
}

export function HostIntegrationSettingsSection({
  scope = 'host',
}: {
  scope?: 'main-agent' | 'host';
}) {
  const isAdmin = useAuthStore((state) => state.user?.role === 'admin');
  const [settings, setSettings] = useState<HostIntegrationSettings | null>(
    null,
  );
  const [draft, setDraft] = useState<HostIntegrationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.get<HostIntegrationSettings>(
        '/api/config/host-integration',
      );
      setSettings(data);
      setDraft(data);
    } catch (error) {
      setLoadError(
        getErrorMessage(error, '无法读取宿主机集成设置，请稍后重试。'),
      );
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  if (!isAdmin) return null;

  if (loading) {
    return (
      <div
        className="flex min-h-32 items-center justify-center"
        aria-label="正在加载宿主机集成设置"
      >
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (loadError || !draft || !settings) {
    return (
      <RetryState
        message={loadError ?? '宿主机集成设置不可用。'}
        onRetry={() => void loadSettings()}
      />
    );
  }

  const dirty =
    scope === 'main-agent'
      ? draft.mainAgentContextSource !== settings.mainAgentContextSource
      : draft.externalClaudeDir !== settings.externalClaudeDir ||
        draft.adminHostOnlyMode !== settings.adminHostOnlyMode;

  const handleSave = async () => {
    setSaving(true);
    try {
      const adminHostOnlyModeChanged =
        draft.adminHostOnlyMode !== settings.adminHostOnlyMode;
      const data = await api.put<HostIntegrationSettings>(
        '/api/config/host-integration',
        draft,
      );
      if (adminHostOnlyModeChanged) {
        // ISSUE-11 B3：chat store 的 loadGroups 已委托 groups store 的唯一
        // loader 并镜像结果，双 loadGroups 收敛为单次调用。
        await Promise.allSettled([
          useChatStore.getState().loadGroups(),
          useTasksStore.getState().loadTasks(),
        ]);
      }
      setSettings(data);
      setDraft(data);
      toast.success(
        scope === 'main-agent'
          ? '主 CKQClaw 默认策略已保存'
          : '宿主机集成设置已保存',
      );
    } catch (error) {
      toast.error(
        getErrorMessage(error, '宿主机集成设置保存失败，请稍后重试。'),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {scope === 'host' && (
        <div className="rounded-lg border border-warning/30 bg-warning-bg px-4 py-3 text-xs leading-5 text-warning">
          这些设置会读取宿主机文件，属于系统级配置。自定义智能体的继承方式请在对应智能体的设置中管理。
        </div>
      )}

      <section className="mt-6 space-y-6">
        {scope === 'main-agent' && (
          <>
            <div className="flex min-h-16 items-start justify-between gap-6">
              <div className="min-w-0">
                <Label htmlFor="host-integration-main-agent-context">
                  主 CKQClaw 继承宿主机 Claude Code 配置
                </Label>
                <p
                  id="host-integration-main-agent-context-description"
                  className="mt-1 text-xs leading-5 text-muted-foreground"
                >
                  开启后自动继承宿主机提示词、Rules、全部 Skills 与 MCP，
                  无需再逐项选择；CKQClaw 管理的能力继续附加。普通用户的 默认
                  CKQClaw 始终使用托管配置。
                </p>
              </div>
              <Switch
                id="host-integration-main-agent-context"
                checked={draft.mainAgentContextSource === 'host_claude'}
                onCheckedChange={(checked) =>
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          mainAgentContextSource: checked
                            ? 'host_claude'
                            : 'managed',
                        }
                      : current,
                  )
                }
                aria-describedby="host-integration-main-agent-context-description"
              />
            </div>

            <div className="border-t border-border pt-6">
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground">自动压缩</p>
                <p
                  id="main-agent-auto-compact-default-description"
                  className="mt-1 text-xs leading-5 text-muted-foreground"
                >
                  全局作用于所有用户的默认 CKQClaw。Pi 运行时在上下文接近窗口
                  上限时自动压缩；历史百分比与固定阈值配置已于 Pi 运行时下线
                  （存量值仅保留存储兼容），实际压缩时机由运行时决定。
                </p>
              </div>
            </div>
          </>
        )}

        {scope === 'host' && (
          <>
            <div className="flex min-h-16 items-start justify-between gap-6">
              <div className="min-w-0">
                <Label htmlFor="admin-host-only-mode">纯宿主机模式</Label>
                <p
                  id="admin-host-only-mode-description"
                  className="mt-1 text-xs leading-5 text-muted-foreground"
                >
                  开启后，工作区和定时任务会统一迁移到宿主机，并禁止再选择
                  Docker。关闭后不会自动把已有工作区迁回
                  Docker。宿主机工作区暂不支持网页终端。
                </p>
              </div>
              <Switch
                id="admin-host-only-mode"
                checked={draft.adminHostOnlyMode}
                onCheckedChange={(checked) =>
                  setDraft((current) =>
                    current
                      ? { ...current, adminHostOnlyMode: checked }
                      : current,
                  )
                }
                aria-describedby="admin-host-only-mode-description"
              />
            </div>

            <div className="border-t border-border pt-6">
              <Label htmlFor="host-integration-claude-dir">
                宿主机 Claude 目录
              </Label>
              <Input
                id="host-integration-claude-dir"
                value={draft.externalClaudeDir}
                onChange={(event) =>
                  setDraft((current) =>
                    current
                      ? { ...current, externalClaudeDir: event.target.value }
                      : current,
                  )
                }
                placeholder="留空使用 ~/.claude"
                aria-describedby="host-integration-claude-dir-description"
                className="mt-2 h-11"
              />
              <p
                id="host-integration-claude-dir-description"
                className="mt-1.5 text-xs leading-5 text-muted-foreground"
              >
                留空时使用当前服务用户的
                ~/.claude；自定义目录必须是宿主机上的绝对路径。
                当前目录同时作为提示词、Rules、Skills 与 MCP 的来源。
              </p>
            </div>

            <div className="grid gap-2 border-t border-border pt-6 sm:grid-cols-2">
              <Link
                to="/capabilities/mcp"
                className="flex min-h-11 items-center justify-between rounded-lg border border-border px-3 text-sm font-medium text-foreground hover:bg-muted"
              >
                导入宿主机 MCP 副本
                <ArrowRight className="size-4 text-muted-foreground" />
              </Link>
            </div>
          </>
        )}
      </section>

      <div className="mt-6 flex justify-end border-t border-border pt-4">
        <Button
          onClick={() => void handleSave()}
          disabled={saving || !dirty}
          className="min-h-11"
        >
          {saving && (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          )}
          {scope === 'main-agent' ? '保存主智能体设置' : '保存宿主机设置'}
        </Button>
      </div>
    </div>
  );
}
