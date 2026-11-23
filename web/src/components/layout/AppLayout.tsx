import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { UnifiedSidebar } from './UnifiedSidebar';
import { BottomTabBar } from './BottomTabBar';
import { ConnectionBanner } from '../common/ConnectionBanner';
import { wsManager } from '../../api/ws';
import { useTheme } from '../../hooks/useTheme';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useRouteRestore } from '../../hooks/useRouteRestore';
import { useGroupsStore } from '../../stores/groups';
import { useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { ErrorBoundary } from '../common/ErrorBoundary';

export function AppLayout() {
  const location = useLocation();
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const isChatRoute = location.pathname.startsWith('/chat');
  const hideMobileTabBar = /^\/chat\/.+/.test(location.pathname);
  useTheme(); // 应用并同步持久化的主题偏好
  useRouteRestore(); // PWA 重启时恢复上次访问的路由（默认关闭，设置中启用）

  // Sidebar: expanded only on chat route, collapsed on other routes
  const [userCollapsed, setUserCollapsed] = useState(false);
  const sidebarCollapsed = isChatRoute ? userCollapsed : true;

  // Keyboard shortcut: Cmd+B (Mac) / Ctrl+B (Windows) to toggle sidebar
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        if (isChatRoute) setUserCollapsed((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isChatRoute]);

  // 应用级别建立 WebSocket 连接，确保所有页面（非仅 ChatView）都有连接
  useEffect(() => {
    wsManager.connect();
  }, []);

  // Process lifecycle (legacy) plus logical query lifecycle. A conversation
  // process may stay warm between turns, so run_started/active_run_snapshot
  // are the authoritative signals for immediate and reconnect restoration.
  useEffect(() => {
    const unsubRunner = wsManager.on('runner_state', (data: any) => {
      if (data.chatJid && data.state) {
        if (!data.chatJid.includes('#agent:')) {
          useGroupsStore.getState().setRunnerState(data.chatJid, data.state);
        }
        useChatStore.getState().handleRunnerState(data.chatJid, data.state);
      }
    });
    const unsubStarted = wsManager.on('run_started', (data: any) => {
      if (!data.chatJid) return;
      if (!data.chatJid.includes('#agent:')) {
        useGroupsStore.getState().setRunnerState(data.chatJid, 'running');
      }
      useChatStore.getState().handleRunStarted(data.chatJid, data.runId);
    });
    const unsubFinished = wsManager.on('run_finished', (data: any) => {
      if (!data.chatJid || !data.runId) return;
      useChatStore.getState().handleRunFinished(data.chatJid, data.runId);
    });
    const unsubSnapshot = wsManager.on('active_run_snapshot', (data: any) => {
      const runs = Array.isArray(data.runs) ? data.runs : [];
      const queuedChatJids = Array.isArray(data.queuedChatJids)
        ? data.queuedChatJids
        : [];
      useChatStore.getState().handleActiveRunSnapshot(runs, queuedChatJids);
      for (const run of runs) {
        if (!run?.chatJid) continue;
        if (!run.chatJid.includes('#agent:')) {
          useGroupsStore.getState().setRunnerState(run.chatJid, 'running');
        }
      }
    });
    return () => {
      unsubRunner();
      unsubStarted();
      unsubFinished();
      unsubSnapshot();
    };
  }, []);

  // 监听 group_created（IM /new 命令、Agent register_group 工具等不经 Web 的
  // 工作区创建，生产者见 src/web.ts broadcastGroupCreated），刷新侧边栏和任务列表。
  // 侧栏工作区列表读的是 chat store（UnifiedSidebar 读 s.groups），刷新必须
  // 落在同一 store 上；groups store 的双份加载收敛见 ISSUE-11。
  useEffect(() => {
    const unsub = wsManager.on('group_created', () => {
      useChatStore.getState().loadGroups();
      // Also refresh tasks — workspace_folder may have been populated
      import('../../stores/tasks').then((m) =>
        m.useTasksStore.getState().loadTasks(),
      );
    });
    return () => {
      unsub();
    };
  }, []);

  // 更新 document.title，显示未读回复数
  const totalUnread = useChatStore((s) =>
    Object.values(s.unreadReplies).reduce((sum, n) => sum + n, 0),
  );
  const appearance = useAuthStore((s) => s.appearance);
  useEffect(() => {
    const appName = appearance?.appName || 'CKQClaw';
    document.title = totalUnread > 0 ? `(${totalUnread}) ${appName}` : appName;
  }, [totalUnread, appearance?.appName]);

  // 全局监听 agent_status，确保不在 ChatView 页面时也能更新 sub-agent 状态
  useEffect(() => {
    const unsub = wsManager.on('agent_status', (data: any) => {
      if (data.chatJid && data.agentId) {
        useChatStore
          .getState()
          .handleAgentStatus(
            data.chatJid,
            data.agentId,
            data.status,
            data.name,
            data.prompt,
            data.resultSummary,
            data.kind,
            data.titleGenerating,
          );
      }
    });
    return () => {
      unsub();
    };
  }, []);

  // 全局监听 agent_reply 的 ⚠️ 警告（notice=true：图片/文件投递失败等）。
  // 未标记的完整回复广播由 new_message 承载，前端不在此消费。
  useEffect(() => {
    const unsub = wsManager.on('agent_reply', (data: any) => {
      if (
        data.notice === true &&
        data.chatJid &&
        typeof data.text === 'string'
      ) {
        useChatStore.getState().handleAgentNotice(data.chatJid, data.text);
      }
    });
    return () => {
      unsub();
    };
  }, []);

  return (
    <div className="h-screen supports-[height:100dvh]:h-dvh flex flex-col lg:flex-row overflow-hidden safe-area-top">
      {/* `hidden lg:block` 只是视觉隐藏，移动端此前仍会挂载整棵侧边栏
          （含每个工作区一个 DropdownMenu/Tooltip）并触发数据加载；
          条件挂载让手机只渲染真正可见的那份列表。 */}
      {isDesktop && (
        <div className="hidden lg:block h-full flex-shrink-0">
          <UnifiedSidebar
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => setUserCollapsed((prev) => !prev)}
          />
        </div>
      )}

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden relative">
        <ConnectionBanner />
        <main
          data-app-scroll-root="true"
          className={`flex-1 min-h-0 lg:overflow-auto lg:pb-0 ${
            isChatRoute
              ? 'overflow-hidden'
              : `overflow-y-auto overflow-x-hidden overscroll-y-none ${hideMobileTabBar ? 'pb-6' : 'pb-nav-safe'}`
          }`}
        >
          <ErrorBoundary resetKeys={[location.pathname]}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>

      {!hideMobileTabBar && <BottomTabBar />}
    </div>
  );
}
