import type { Permission } from '../../stores/auth';

// ISSUE-11 B4：本地 getErrorMessage 副本收敛为共享 extractErrorMessage 的
// 重导出别名（消费面 AuditLogTab / InviteCodesTab / UserListTab 的 import
// 不动）。行为统一基准：Error.message → 对象 .message → String(err)，
// 不 trim；fallback 仅在提取结果为空时生效。
export { extractErrorMessage as getErrorMessage } from '../../utils/error';

export function samePermissions(
  left: Permission[],
  right: Permission[],
): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, idx) => value === b[idx]);
}

export const PERMISSION_LABELS: Record<Permission, string> = {
  manage_system_config: '系统配置管理',
  manage_group_env: '工作区环境管理',
  manage_users: '用户管理',
  manage_invites: '邀请码管理',
  view_audit_log: '查看审计日志',
};

export const ROLE_LABELS: Record<string, string> = {
  admin: '管理员',
  member: '普通成员',
};
export interface TabNotification {
  setNotice: (value: string | null) => void;
  setError: (value: string | null) => void;
}
