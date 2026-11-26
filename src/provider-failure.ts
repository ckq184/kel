export const PROVIDER_FAILURE_USER_NOTICE =
  '⚠️ 当前模型服务额度已用尽或暂时不可用，本次处理已停止。请稍后重试，或到「设置 → 模型服务」切换可用模型。';

export const PROVIDER_AUTH_USER_NOTICE =
  '⚠️ 模型服务认证失败：API Key 无效或已过期，本次处理已停止（已跳过自动重试）。请到「设置 → 模型服务」检查并更新 API Key 后重试。';

/**
 * Provider 认证/授权类永久性错误：重试注定失败（Key 无效是确定性状态），
 * 必须快速失败并即时透出，而非进入静默退避重试循环。
 *
 * 匹配刻意收窄，避免把 5xx/429/网络抖动等瞬时错误误判为永久：
 * - 行首 HTTP 状态码（Pi runner errorMessage 形态：`401 {"error":…}`）；
 * - Anthropic 官方鉴权失败文案（含被宿主包装的形态）；
 * - 智谱端点中文鉴权失败文案。
 */
const PERMANENT_AUTH_ERROR_PATTERNS: RegExp[] = [
  /^40[13]\b/,
  /authentication_failed/i,
  /invalid[ _]x-api-key/i,
  /invalid_api_key/i,
  /令牌已过期或验证不正确/,
];

export function isPermanentProviderAuthError(error: string): boolean {
  return PERMANENT_AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(error));
}

interface ProviderFailureHealth {
  profileId: string;
  healthy: boolean;
}

interface ProviderFailureDisposition {
  /** Another configured provider can replay the same durable input. */
  retryElsewhere: boolean;
  /** The provider pool is exhausted, so the user input must end visibly. */
  terminal: boolean;
}

/**
 * Decide whether an account/provider failure should remain a control-plane
 * retry signal or become a terminal user-visible failure.
 *
 * The failed provider must be quarantined before this function is called.
 */
export function resolveProviderFailureDisposition(
  selectedProfileId: string | null,
  health: ProviderFailureHealth[],
): ProviderFailureDisposition {
  const retryElsewhere =
    selectedProfileId !== null &&
    health.some(
      (candidate) =>
        candidate.profileId !== selectedProfileId && candidate.healthy,
    );
  return {
    retryElsewhere,
    terminal: !retryElsewhere,
  };
}
