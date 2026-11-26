import { useEffect, useState } from 'react';
import {
  ArrowRight,
  KeyRound,
  Loader2,
  Link2,
  Plus,
  Server,
  ShieldCheck,
  SkipForward,
  X,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api } from '../api/client';
import type {
  UnifiedProviderPublic,
  EnvRow,
} from '../components/settings/types';
import { getErrorMessage } from '../components/settings/types';
import { useAuthStore } from '../stores/auth';
import { buildCustomEnv, envRowsToText } from '../utils/custom-env';

export function SetupProvidersPage() {
  const navigate = useNavigate();
  const { user, setupStatus, checkAuth, initialized } = useAuthStore();

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Feishu (no prefilled defaults)
  const [feishuAppId, setFeishuAppId] = useState('');
  const [feishuAppSecret, setFeishuAppSecret] = useState('');

  // 第三方端点
  const [baseUrl, setBaseUrl] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [model, setModel] = useState('');
  const [customEnvRows, setCustomEnvRows] = useState<EnvRow[]>([]);

  useEffect(() => {
    if (user === null && initialized === true) {
      navigate('/login', { replace: true });
    }
  }, [user, initialized, navigate]);

  useEffect(() => {
    if (setupStatus && !setupStatus.needsSetup) {
      navigate('/settings?tab=claude', { replace: true });
    }
  }, [setupStatus, navigate]);

  const addCustomEnvRow = () =>
    setCustomEnvRows((rows) => [...rows, { key: '', value: '' }]);
  const removeCustomEnvRow = (idx: number) =>
    setCustomEnvRows((rows) => rows.filter((_, i) => i !== idx));
  const updateCustomEnvRow = (
    idx: number,
    field: keyof EnvRow,
    value: string,
  ) =>
    setCustomEnvRows((rows) =>
      rows.map((row, i) => (i === idx ? { ...row, [field]: value } : row)),
    );

  const handleFinish = async () => {
    setError(null);

    if (feishuAppSecret.trim() && !feishuAppId.trim()) {
      setError('填写飞书 Secret 时，App ID 也必须填写');
      return;
    }

    if (!baseUrl.trim()) {
      setError('第三方渠道必须填写 ANTHROPIC_BASE_URL');
      return;
    }
    if (!authToken.trim()) {
      setError('第三方渠道必须填写 ANTHROPIC_AUTH_TOKEN');
      return;
    }
    const envResult = buildCustomEnv(envRowsToText(customEnvRows));
    if (envResult.error) {
      setError(envResult.error);
      return;
    }
    const customEnv = envResult.customEnv;

    setSaving(true);
    try {
      // Feishu is optional. Only save when user entered anything. Credentials
      // flow through /api/channel-accounts: PATCH the existing Feishu account
      // if one exists (the legacy singleton config is projected as an account
      // automatically), otherwise create a new account. Server-side
      // syncLegacyUserImFacade mirrors first-class mutations back to the
      // legacy store, so no extra compatibility write is needed here.
      if (feishuAppId.trim() || feishuAppSecret.trim()) {
        const credentials: Record<string, string> = {
          appId: feishuAppId.trim(),
        };
        if (feishuAppSecret.trim())
          credentials.appSecret = feishuAppSecret.trim();
        const { accounts } = await api.get<{
          accounts: Array<{ id: string; provider: string }>;
        }>('/api/channel-accounts');
        const existing = accounts.find((item) => item.provider === 'feishu');
        if (existing) {
          await api.patch(
            `/api/channel-accounts/${encodeURIComponent(existing.id)}`,
            { credentials },
          );
        } else {
          await api.post('/api/channel-accounts', {
            provider: 'feishu',
            name: '飞书',
            enabled: true,
            credentials,
          });
        }
      }

      await api.post<UnifiedProviderPublic>('/api/config/claude/providers', {
        name: '默认第三方',
        type: 'third_party',
        anthropicBaseUrl: baseUrl.trim(),
        anthropicAuthToken: authToken.trim(),
        anthropicModel: model.trim(),
        customEnv,
        enabled: true,
      });

      await checkAuth();
      // 确认 setupStatus 已更新后再跳转，避免 AuthGuard 检测到 needsSetup 仍为 true 导致重定向循环
      const { setupStatus: latestStatus } = useAuthStore.getState();
      if (latestStatus?.needsSetup) {
        setError('配置已保存但验证未通过，请检查填写的配置是否正确');
        return;
      }
      navigate('/settings?tab=claude', { replace: true });
    } catch (err) {
      setError(getErrorMessage(err, '保存初始化配置失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleSkip = async () => {
    setError(null);
    setSaving(true);
    try {
      await api.put('/api/config/system', { providerSetupSkipped: true });
      await checkAuth();
      navigate('/chat', { replace: true });
    } catch (err) {
      setError(getErrorMessage(err, '暂时跳过初始化失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-screen bg-background overflow-y-auto p-4">
      <div className="w-full max-w-4xl mx-auto space-y-5">
        <div className="text-center">
          <p className="text-xs font-semibold text-primary tracking-wider mb-2">
            STEP 2 / 2
          </p>
          <h1 className="text-2xl font-bold text-foreground mb-2">
            系统接入初始化
          </h1>
          <p className="text-sm text-muted-foreground">
            此页面保存的是系统全局默认配置。你也可以先跳过，稍后在设置中完成。
          </p>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-error-bg border border-error/30 text-error text-sm">
            {error}
          </div>
        )}

        <section className="bg-card rounded-xl border border-border shadow-sm p-5">
          <div className="flex items-center gap-2 mb-3">
            <Link2 className="w-4 h-4 text-primary" />
            <h2 className="text-base font-semibold text-foreground">
              飞书配置（可选）
            </h2>
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            首装不预填任何默认值，全部由你手动输入。
          </p>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                App ID
              </label>
              <Input
                type="text"
                value={feishuAppId}
                onChange={(e) => setFeishuAppId(e.target.value)}
                placeholder="输入飞书 App ID"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                App Secret
              </label>
              <Input
                type="password"
                value={feishuAppSecret}
                onChange={(e) => setFeishuAppSecret(e.target.value)}
                placeholder="输入飞书 App Secret"
              />
            </div>
          </div>
        </section>

        <section className="bg-card rounded-xl border border-border shadow-sm p-5">
          <div className="flex items-center gap-2 mb-3">
            <KeyRound className="w-4 h-4 text-primary" />
            <h2 className="text-base font-semibold text-foreground">
              Claude Code 配置
            </h2>
          </div>

          <div className="space-y-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Server className="w-4 h-4 text-primary" />
              第三方渠道会写入系统全局默认环境变量。必填项为 ANTHROPIC_BASE_URL
              和 ANTHROPIC_AUTH_TOKEN。
            </div>

            <div className="grid grid-cols-1 gap-3">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  ANTHROPIC_BASE_URL（必填）
                </label>
                <Input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://your-relay.example.com/v1"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  ANTHROPIC_MODEL（可选）
                </label>
                <Input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="opus / sonnet / haiku 或 glm-5.2 等第三方模型名"
                  className="font-mono"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  ANTHROPIC_AUTH_TOKEN（必填）
                </label>
                <Input
                  type="password"
                  value={authToken}
                  onChange={(e) => setAuthToken(e.target.value)}
                  placeholder="输入第三方网关 Token"
                />
              </div>
            </div>

            <div className="border-t border-border pt-4">
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-muted-foreground">
                  其他自定义环境变量（可选）
                </label>
                <button
                  type="button"
                  onClick={addCustomEnvRow}
                  className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  添加
                </button>
              </div>
              <p className="mb-2 text-xs text-muted-foreground">
                这些变量属于系统全局设置，后续切换第三方配置时不会跟随切换。
              </p>

              {customEnvRows.length === 0 ? (
                <p className="text-xs text-muted-foreground">暂无</p>
              ) : (
                <div className="space-y-2">
                  {customEnvRows.map((row, idx) => (
                    <div
                      key={idx}
                      className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2"
                    >
                      <Input
                        type="text"
                        value={row.key}
                        onChange={(e) =>
                          updateCustomEnvRow(idx, 'key', e.target.value)
                        }
                        placeholder="KEY"
                        className="w-full sm:w-[38%] px-2.5 py-1.5 text-xs font-mono h-auto"
                      />
                      <Input
                        type="text"
                        value={row.value}
                        onChange={(e) =>
                          updateCustomEnvRow(idx, 'value', e.target.value)
                        }
                        placeholder="value"
                        className="flex-1 px-2.5 py-1.5 text-xs font-mono h-auto"
                      />
                      <button
                        type="button"
                        onClick={() => removeCustomEnvRow(idx)}
                        className="w-8 h-8 rounded-md hover:bg-muted text-muted-foreground hover:text-error flex items-center justify-center cursor-pointer"
                        aria-label="删除环境变量"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        <div className="bg-card rounded-xl border border-border shadow-sm p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div className="text-sm text-muted-foreground flex items-start gap-2">
            <ShieldCheck className="w-4 h-4 text-primary mt-0.5 shrink-0" />
            <span>
              当前页保存的数据会作为系统全局默认配置，后续可在后台设置页继续修改。
            </span>
          </div>
          <div className="flex items-center justify-end gap-2 shrink-0">
            <Button variant="ghost" onClick={handleSkip} disabled={saving}>
              <SkipForward className="size-4" />
              稍后设置
            </Button>
            <Button
              onClick={handleFinish}
              disabled={saving}
              className="min-w-52"
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              保存并进入后台
              <ArrowRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
