import { MessageCircle, Clock4, Bot, Puzzle, Settings } from 'lucide-react';

interface NavItem {
  path: string;
  icon: typeof MessageCircle;
  label: string;
}

export const navItems: NavItem[] = [
  { path: '/chat', icon: MessageCircle, label: '工作台' },
  { path: '/agent-profiles', icon: Bot, label: '智能体' },
  { path: '/capabilities', icon: Puzzle, label: '能力库' },
  { path: '/tasks', icon: Clock4, label: '任务' },
  { path: '/settings', icon: Settings, label: '设置' },
];
