import { useNavigate } from 'react-router-dom';
import { LogOut, UserCog } from 'lucide-react';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useAuthStore } from '../../stores/auth';
import { EmojiAvatar } from './EmojiAvatar';

interface UserMenuPopoverProps {
  /** 弹出方向：桌面侧栏向右，移动端聊天页向下。 */
  side: 'right' | 'bottom';
  ariaLabel?: string;
  triggerClassName?: string;
}

/**
 * THESIS-27 W3：桌面侧栏与移动端聊天页原先各有一份逐字相同的用户头像
 * Popover（约 36 行），差异只有弹出方向、aria-label 与触发按钮间距。
 */
export function UserMenuPopover({
  side,
  ariaLabel,
  triggerClassName,
}: UserMenuPopoverProps) {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const userInitial = (user?.display_name ||
    user?.username ||
    '?')[0].toUpperCase();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={cn(
            'rounded-full hover:ring-2 hover:ring-brand-200 transition-all cursor-pointer',
            triggerClassName,
          )}
          aria-label={ariaLabel}
        >
          <EmojiAvatar
            imageUrl={user?.avatar_url}
            emoji={user?.avatar_emoji}
            color={user?.avatar_color}
            fallbackChar={userInitial}
            size="md"
            className="w-8 h-8"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent side={side} align="end" className="w-44 p-1">
        <div className="px-3 py-2 text-xs font-medium text-muted-foreground truncate border-b border-border mb-1">
          {user?.display_name || user?.username}
        </div>
        <button
          onClick={() => navigate('/settings?tab=profile')}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-accent text-foreground cursor-pointer"
        >
          <UserCog className="w-4 h-4" /> 个人设置
        </button>
        <button
          onClick={async () => {
            await useAuthStore.getState().logout();
            navigate('/login');
          }}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-destructive/10 text-destructive cursor-pointer"
        >
          <LogOut className="w-4 h-4" /> 退出登录
        </button>
      </PopoverContent>
    </Popover>
  );
}
