// ─── 统一供应商类型 (V4) ─────────────────────────────────────

// 任务AL：窗口声明预设的单一真相在 utils/provider-model.ts，此处转发。
import type { ContextWindowPreset } from '../../utils/provider-model';
export type { ContextWindowPreset };

export interface UnifiedProviderPublic {
  id: string;
  name: string;
  type: 'official' | 'third_party';
  enabled: boolean;
  weight: number;
  anthropicBaseUrl: string;
  anthropicModel: string;
  contextWindow?: ContextWindowPreset;
  hasAnthropicAuthToken: boolean;
  anthropicAuthTokenMasked: string | null;
  hasAnthropicApiKey: boolean;
  anthropicApiKeyMasked: string | null;
  hasClaudeCodeOauthToken: boolean;
  claudeCodeOauthTokenMasked: string | null;
  hasClaudeOAuthCredentials: boolean;
  claudeOAuthCredentialsExpiresAt: number | null;
  claudeOAuthCredentialsAccessTokenMasked: string | null;
  customEnv: Record<string, string>;
  updatedAt: string;
}

export interface ProviderHealthStatus {
  profileId: string;
  healthy: boolean;
  consecutiveErrors: number;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
  unhealthySince: number | null;
  activeSessionCount: number;
}

export interface ProviderWithHealth extends UnifiedProviderPublic {
  health: ProviderHealthStatus | null;
}

export interface BalancingConfig {
  strategy: 'round-robin' | 'weighted-round-robin' | 'failover';
  unhealthyThreshold: number;
  recoveryIntervalMs: number;
}

export interface ProvidersListResponse {
  providers: ProviderWithHealth[];
  balancing: BalancingConfig;
  enabledCount: number;
  defaultProviderId: string | null;
}

// ─── 通用类型 ────────────────────────────────────────────────

export interface EnvRow {
  key: string;
  value: string;
}

export interface SessionInfo {
  shortId: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  last_active_at: string;
  is_current: boolean;
}

export interface SystemSettings {
  containerTimeout: number;
  idleTimeout: number;
  containerMaxOutputSize: number;
  maxConcurrentContainers: number;
  maxLoginAttempts: number;
  loginLockoutMinutes: number;
  fallbackModel: string;
}

export interface HostIntegrationSettings {
  adminHostOnlyMode: boolean;
  mainAgentContextSource: 'managed' | 'host_claude';
  mainAgentAutoCompactWindow: number;
  mainAgentAutoCompactPercentage: number;
  externalClaudeDir: string;
}

// ─── OAuth Usage ────────────────────────────────────────────

export interface OAuthUsageBucket {
  utilization: number;
  resets_at: string;
}

export interface OAuthUsageResponse {
  five_hour: OAuthUsageBucket | null;
  seven_day: OAuthUsageBucket | null;
  seven_day_opus: OAuthUsageBucket | null;
  seven_day_sonnet: OAuthUsageBucket | null;
}

export interface CachedOAuthUsage {
  data: OAuthUsageResponse;
  fetchedAt: number;
  error?: string;
}

export type SettingsTab =
  | 'claude'
  | 'registration'
  | 'appearance'
  | 'system'
  | 'main-agent'
  | 'host-integration'
  | 'pricing'
  | 'profile'
  | 'preferences'
  | 'my-channels'
  | 'security'
  | 'groups'
  | 'agent-profiles'
  | 'memory'
  | 'skills'
  | 'mcp-servers'
  | 'users'
  | 'about'
  | 'bindings'
  | 'usage'
  | 'monitor';

export function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim()) return msg;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
