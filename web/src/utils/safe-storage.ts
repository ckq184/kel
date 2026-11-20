/**
 * localStorage 安全访问（ISSUE-11 B5）。
 *
 * 原 routeRestore.ts 与 workspaceLastAgent.ts 各持一份逐字相同的实现，
 * 收敛为唯一导出。隐私模式/沙箱等场景下访问 localStorage 全局可能抛错
 * （或全局未定义），统一回退 null，由调用方自行跳过持久化。
 */
export function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
