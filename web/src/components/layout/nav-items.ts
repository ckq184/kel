import {
  MessageCircle,
  Clock4,
  Bot,
  Puzzle,
  BarChart3,
  Wallet,
  Settings,
  FlaskConical,
} from 'lucide-react';
import type { Permission } from '../../stores/auth';

interface NavItem {
  path: string;
  icon: typeof MessageCircle;
  label: string;
  requiresBilling?: boolean;
  hideOnMobile?: boolean;
  /** 任务 AQ：标注后仅持有该权限的用户可见（缺 predicate 时 fail-closed 隐藏）。 */
  requiredPermission?: Permission;
}

export const baseNavItems: NavItem[] = [
  { path: '/chat', icon: MessageCircle, label: '工作台' },
  { path: '/agent-profiles', icon: Bot, label: '智能体' },
  { path: '/capabilities', icon: Puzzle, label: '能力库' },
  { path: '/tasks', icon: Clock4, label: '任务' },
  { path: '/usage', icon: BarChart3, label: '用量', hideOnMobile: true },
  {
    path: '/eval',
    icon: FlaskConical,
    label: '评测',
    hideOnMobile: true,
    requiredPermission: 'manage_system_config',
  },
  { path: '/billing', icon: Wallet, label: '账单', requiresBilling: true },
  { path: '/settings', icon: Settings, label: '设置' },
];

export function filterNavItems(
  billingEnabled: boolean,
  hasPermission?: (permission: Permission) => boolean,
) {
  return baseNavItems.filter(
    (item) =>
      (!item.requiresBilling || billingEnabled) &&
      (!item.requiredPermission || hasPermission?.(item.requiredPermission)),
  );
}
