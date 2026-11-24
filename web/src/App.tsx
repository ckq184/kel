/**
 * 前端路由真相源：全部路由集中在本文件的 `appRoutes`（createRoutesFromElements）。
 *
 * 结构：
 * - 公开路由：/login /setup（首启引导）；
 * - 受保护路由统一包在 AuthGuard + AppLayout 布局内（/setup/providers 与
 *   /setup/channels 仅 AuthGuard 无布局）；
 * - 页面组件全部 React.lazy 按需加载；ChatPage 另有手动 preload（下方
 *   shouldPreloadChatRoute——历史上静态 modulepreload 让 /login 也下载了
 *   ChatPage + MarkdownRenderer 的整条依赖链）；
 * - 兼容重定向：/groups→/chat、/skills→/capabilities/skills、
 *   /mcp-servers→/capabilities/mcp、/ 与 * → /chat。
 *
 * 路由器按 shouldUseHashRouter() 在 hash/browser 两种模式间选择
 * （iOS PWA standalone 模式退回 hash），basename 取 APP_BASE。
 */
import {
  Route,
  Navigate,
  RouterProvider,
  createBrowserRouter,
  createHashRouter,
  createRoutesFromElements,
} from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { LoginPage } from './pages/LoginPage';
import { SetupPage } from './pages/SetupPage';
import { SetupProvidersPage } from './pages/SetupProvidersPage';
import { SetupChannelsPage } from './pages/SetupChannelsPage';
import { AuthGuard } from './components/auth/AuthGuard';
import { AppLayout } from './components/layout/AppLayout';
import { APP_BASE, shouldUseHashRouter } from './utils/url';
import { shouldPreloadChatRoute } from './utils/chat-route-preload';
import { Toaster } from '@/components/ui/sonner';

let chatPagePromise:
  | Promise<{ default: typeof import('./pages/ChatPage').ChatPage }>
  | undefined;
const loadChatPage = () =>
  (chatPagePromise ??= import('./pages/ChatPage').then((m) => ({
    default: m.ChatPage,
  })));
const ChatPage = lazy(loadChatPage);

// Start the expensive chat split as soon as the entry executes, but only for
// the default/chat routes. Static HTML modulepreloads made login, setup, tasks,
// and memory download ChatPage + MarkdownRenderer even when never used.
if (
  typeof window !== 'undefined' &&
  shouldPreloadChatRoute(
    window.location.pathname,
    window.location.hash,
    APP_BASE,
  )
) {
  void loadChatPage();
}
const TasksPage = lazy(() =>
  import('./pages/TasksPage').then((m) => ({ default: m.TasksPage })),
);
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);
const AgentProfilesPage = lazy(() =>
  import('./pages/AgentProfilesPage').then((m) => ({
    default: m.AgentProfilesPage,
  })),
);
// These four were the only synchronous authed routes left. CapabilitiesPage in
// particular statically pulls SkillsPage → MarkdownRenderer → KaTeX +
// highlight.js, which hoisted that whole chain into the entry chunk (~1.74MB
// raw, 517KB gzip) and made even /login download it.
const MemoryPage = lazy(() =>
  import('./pages/MemoryPage').then((m) => ({ default: m.MemoryPage })),
);
const MonitorPage = lazy(() =>
  import('./pages/MonitorPage').then((m) => ({ default: m.MonitorPage })),
);
const CapabilitiesPage = lazy(() =>
  import('./pages/CapabilitiesPage').then((m) => ({
    default: m.CapabilitiesPage,
  })),
);

function AgentProfilesRouteFallback() {
  return (
    <div
      className="min-h-full px-4 py-5 sm:px-6 lg:px-8 lg:py-8"
      role="status"
      aria-live="polite"
    >
      <div className="mx-auto max-w-6xl rounded-xl border border-border bg-card/40 p-6 text-sm text-muted-foreground motion-safe:animate-pulse">
        正在加载智能体设置…
      </div>
    </div>
  );
}

const appRoutes = createRoutesFromElements(
  <>
    {/* Public Routes */}
    <Route path="/login" element={<LoginPage />} />
    {/* 首次启动引导（创建管理员/配置 Provider/渠道） */}
    <Route path="/setup" element={<SetupPage />} />
    {/* 引导的后续两步：已登录但无布局包裹 */}
    <Route
      path="/setup/providers"
      element={
        <AuthGuard>
          <SetupProvidersPage />
        </AuthGuard>
      }
    />
    <Route
      path="/setup/channels"
      element={
        <AuthGuard>
          <SetupChannelsPage />
        </AuthGuard>
      }
    />

    {/* Protected Routes with Layout */}
    <Route
      element={
        <AuthGuard>
          <AppLayout />
        </AuthGuard>
      }
    >
      {/* 主聊天页：可选 groupFolder 直接定位到某工作区 */}
      <Route
        path="/chat/:groupFolder?"
        element={
          <Suspense
            fallback={
              <div
                className="flex h-full items-center justify-center text-sm text-muted-foreground motion-safe:animate-pulse"
                role="status"
                aria-live="polite"
              >
                正在加载会话…
              </div>
            }
          >
            <ChatPage />
          </Suspense>
        }
      />
      <Route path="/groups" element={<Navigate to="/chat" replace />} />
      {/* 智能体档案（Agent Builder）管理页 */}
      <Route
        path="/agent-profiles"
        element={
          <Suspense fallback={<AgentProfilesRouteFallback />}>
            <AgentProfilesPage />
          </Suspense>
        }
      />
      {/* 定时任务列表与详情 */}
      <Route
        path="/tasks"
        element={
          <Suspense fallback={null}>
            <TasksPage />
          </Suspense>
        }
      />
      {/* 系统监控（上下文审计/渠道可靠性），仅 manage_system_config 权限 */}
      <Route
        path="/monitor"
        element={
          <AuthGuard requiredPermission="manage_system_config">
            <Suspense fallback={null}>
              <MonitorPage />
            </Suspense>
          </AuthGuard>
        }
      />
      {/* 工作区记忆管理 */}
      <Route
        path="/memory"
        element={
          <Suspense fallback={null}>
            <MemoryPage />
          </Suspense>
        }
      />
      {/* 能力中心：skills / mcp 等分节（section 参数定位） */}
      <Route
        path="/capabilities/:section?"
        element={
          <Suspense fallback={null}>
            <CapabilitiesPage />
          </Suspense>
        }
      />
      <Route
        path="/skills"
        element={<Navigate to="/capabilities/skills" replace />}
      />
      <Route
        path="/mcp-servers"
        element={<Navigate to="/capabilities/mcp" replace />}
      />
      {/* 系统设置（Provider/渠道账号/偏好/定价等分节） */}
      <Route
        path="/settings"
        element={
          <Suspense fallback={null}>
            <SettingsPage />
          </Suspense>
        }
      />
    </Route>

    {/* Default redirect — go through AuthGuard to detect setup state */}
    <Route path="/" element={<Navigate to="/chat" replace />} />
    <Route path="*" element={<Navigate to="/chat" replace />} />
  </>,
);

function createAppRouter(useHashRouter = shouldUseHashRouter()) {
  const options = {
    basename: APP_BASE === '/' ? undefined : APP_BASE,
  };
  return useHashRouter
    ? createHashRouter(appRoutes, options)
    : createBrowserRouter(appRoutes, options);
}

let appRouter: ReturnType<typeof createAppRouter> | undefined;

function getAppRouter() {
  appRouter ??= createAppRouter();
  return appRouter;
}

export function App() {
  return (
    <>
      <Toaster position="top-right" richColors />
      <RouterProvider router={getAppRouter()} />
    </>
  );
}
