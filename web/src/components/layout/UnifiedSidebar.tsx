import { useState, useEffect } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { PanelLeftClose, Plus } from 'lucide-react';
import { useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { useGroupsStore } from '../../stores/groups';
import { useClearWorkspace } from '../../hooks/useClearWorkspace';
import { ConfirmDialog } from '@/components/common';
import { UserMenuPopover } from '@/components/common/UserMenuPopover';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ChatGroupItem } from '../chat/ChatGroupItem';
import { DeleteWorkspaceDialog } from '../chat/DeleteWorkspaceDialog';
import { AgentWorkspaceGroup } from './AgentWorkspaceGroup';
import { CreateContainerDialog } from '../chat/CreateContainerDialog';
import { RenameDialog } from '../chat/RenameDialog';
import { SkeletonCardList } from '@/components/common/Skeletons';
import { cn } from '@/lib/utils';
import { navItems } from './nav-items';
import { useAgentWorkspaceSections } from '../../hooks/useAgentWorkspaceSections';
import {
  buildAgentCapabilitiesHref,
  getAgentNavigationTargets,
  getPrimaryAgentWorkspaceRows,
  isAgentSectionCollapsible,
} from '../../utils/agent-product';
import { useDeleteWorkspace } from '../../hooks/useDeleteWorkspace';

interface UnifiedSidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export function UnifiedSidebar({
  collapsed,
  onToggleCollapse,
}: UnifiedSidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const isChatRoute = location.pathname.startsWith('/chat');
  const showWorkspaceList = isChatRoute && !collapsed;

  const appearance = useAuthStore((s) => s.appearance);

  const [createOpen, setCreateOpen] = useState(false);
  const [renameState, setRenameState] = useState({
    open: false,
    jid: '',
    name: '',
  });
  const {
    clearState,
    clearLoading,
    openClear,
    closeClear,
    handleClearConfirm,
  } = useClearWorkspace();

  // 窄 selector：整 store 订阅会让侧边栏跟着流式输出每帧重渲染。
  const groups = useChatStore((s) => s.groups);
  const currentGroup = useChatStore((s) => s.currentGroup);
  const selectGroup = useChatStore((s) => s.selectGroup);
  const loadGroups = useChatStore((s) => s.loadGroups);
  const loading = useChatStore((s) => s.loading);
  const togglePin = useChatStore((s) => s.togglePin);
  const runnerStates = useGroupsStore((s) => s.runnerStates);
  const {
    deleteState,
    deleteLoading,
    openDelete,
    closeDelete,
    handleDeleteConfirm,
  } = useDeleteWorkspace({
    onDeleted: () => {
      const nextJid = useChatStore.getState().currentGroup;
      const nextFolder = nextJid
        ? useChatStore.getState().groups[nextJid]?.folder
        : null;
      navigate(nextFolder ? `/chat/${nextFolder}` : '/chat');
    },
  });

  useEffect(() => {
    if (isChatRoute) loadGroups();
  }, [isChatRoute, loadGroups]);

  const { allGroups, agentSections, agentPartitions } =
    useAgentWorkspaceSections(groups);

  const handleGroupSelect = (jid: string, folder: string) => {
    selectGroup(jid);
    navigate(`/chat/${folder}`);
  };
  const handleCreated = (jid: string, folder: string) => {
    selectGroup(jid);
    navigate(`/chat/${folder}`);
  };

  const renderAgentSection = (section: (typeof agentSections)[number]) => {
    const { directGroup, workspaces } = getAgentNavigationTargets(section);
    return (
      <AgentWorkspaceGroup
        key={section.id}
        agentId={section.id}
        name={section.name}
        collapsible={isAgentSectionCollapsible(section)}
        workspaceCount={workspaces.length}
        workspaceNames={workspaces.map((workspace) => workspace.name)}
        runningCount={
          section.items.filter((item) => runnerStates[item.jid] === 'running')
            .length
        }
        isDirectActive={
          !!directGroup?.is_my_home && directGroup.jid === currentGroup
        }
        containsActiveWorkspace={section.items.some(
          (item) => item.jid === currentGroup,
        )}
        onSelect={() => {
          if (directGroup) {
            handleGroupSelect(directGroup.jid, directGroup.folder);
          }
        }}
        onRebuild={
          directGroup?.is_my_home && directGroup.can_modify
            ? () => openClear(directGroup.jid, section.name)
            : undefined
        }
        onManageCapabilities={
          // 自定义智能体分组直跳该档案的能力区块（深链处理见 AgentProfilesPage）。
          // '__default__' 是无档案分组的哨兵 id，没有可跳转的档案页。
          section.id !== '__default__'
            ? () => navigate(buildAgentCapabilitiesHref(section.id))
            : undefined
        }
      >
        {workspaces.map((g) => (
          <ChatGroupItem
            key={g.jid}
            jid={g.jid}
            name={g.name}
            folder={g.folder}
            isActive={currentGroup === g.jid}
            isHome={false}
            isPinned={!!g.pinned_at}
            isRunning={runnerStates[g.jid] === 'running'}
            canModify={g.can_modify}
            onSelect={handleGroupSelect}
            onRename={(jid, name) => setRenameState({ open: true, jid, name })}
            onClearHistory={openClear}
            onDelete={openDelete}
            onTogglePin={(jid) => togglePin(jid)}
          />
        ))}
      </AgentWorkspaceGroup>
    );
  };

  const renderPrimaryAgentWorkspaces = (
    section: (typeof agentSections)[number],
  ) => {
    const workspaces = getPrimaryAgentWorkspaceRows(section);
    return (
      <div data-hc-primary-agent-workspaces={section.id}>
        {workspaces.map((g) => (
          <ChatGroupItem
            key={g.jid}
            jid={g.jid}
            name={g.name}
            folder={g.folder}
            isActive={currentGroup === g.jid}
            isHome={!!g.is_my_home}
            isPinned={!!g.pinned_at}
            isRunning={runnerStates[g.jid] === 'running'}
            canModify={g.can_modify}
            onSelect={handleGroupSelect}
            onRename={(jid, name) => setRenameState({ open: true, jid, name })}
            onClearHistory={openClear}
            onDelete={openDelete}
            onTogglePin={(jid) => togglePin(jid)}
          />
        ))}
      </div>
    );
  };

  const panelWidth = showWorkspaceList ? '16.5rem' : '0';

  return (
    <TooltipProvider delayDuration={200}>
      <div className="h-full flex flex-shrink-0">
        <nav className="w-[4.5rem] h-full bg-muted/30 flex flex-col items-center py-3 gap-1 flex-shrink-0">
          <div className="w-11 h-11 rounded-xl overflow-hidden mb-3 flex-shrink-0">
            <img
              src={`${import.meta.env.BASE_URL}icons/icon-192.png`}
              alt="CKQClaw"
              className="w-full h-full object-cover"
            />
          </div>

          {navItems.map(({ path, icon: Icon, label }) => {
            const isChatItem = path === '/chat';
            const isActive = location.pathname.startsWith(path);
            const baseClass =
              'w-12 h-12 rounded-xl flex flex-col items-center justify-center gap-0.5 transition-colors';
            const activeClass = isActive
              ? 'bg-brand-50 text-primary'
              : 'text-muted-foreground hover:bg-accent';

            return (
              <Tooltip key={path}>
                <TooltipTrigger asChild>
                  {isChatItem && isChatRoute ? (
                    <button
                      onClick={onToggleCollapse}
                      className={cn(baseClass, activeClass)}
                    >
                      <Icon
                        className="w-[20px] h-[20px]"
                        strokeWidth={isActive ? 2 : 1.75}
                      />
                      <span className="text-[10px] leading-tight">{label}</span>
                    </button>
                  ) : (
                    <NavLink to={path} className={cn(baseClass, activeClass)}>
                      <Icon
                        className="w-[20px] h-[20px]"
                        strokeWidth={isActive ? 2 : 1.75}
                      />
                      <span className="text-[10px] leading-tight">{label}</span>
                    </NavLink>
                  )}
                </TooltipTrigger>
                <TooltipContent side="right">
                  {isChatItem && isChatRoute
                    ? collapsed
                      ? '展开智能体工作台'
                      : '收起智能体工作台'
                    : label}
                </TooltipContent>
              </Tooltip>
            );
          })}

          {/* Spacer */}
          <div className="flex-1" />

          {/* User avatar popover */}
          <UserMenuPopover side="right" triggerClassName="mb-2" />
        </nav>

        <div
          className="h-full overflow-hidden transition-[width] duration-200 ease-linear"
          style={{ width: panelWidth }}
        >
          <div className="w-[16.5rem] h-full flex flex-col bg-muted/30">
            <div className="flex items-center gap-2 px-4 pt-6 pb-3 mb-3 flex-shrink-0">
              <img
                src={`${import.meta.env.BASE_URL}icons/logo-text.svg`}
                alt={appearance?.appName || 'CKQClaw'}
                className="h-10"
              />
              <div className="flex-1" />
              <button
                onClick={onToggleCollapse}
                className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-accent text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              >
                <PanelLeftClose className="w-4 h-4" />
              </button>
            </div>
            <div className="px-3 pb-2 flex-shrink-0">
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="flex min-h-9 w-full items-center justify-start gap-2 rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
              >
                <Plus className="h-3.5 w-3.5" />
                新建工作区
              </button>
            </div>

            {/* Workspace list */}
            <div className="flex-1 overflow-y-auto px-1.5">
              {loading && allGroups.length === 0 ? (
                <SkeletonCardList count={6} compact />
              ) : agentSections.length === 0 ? (
                <div className="flex h-32 flex-col items-center justify-center px-4">
                  <p className="text-center text-xs text-muted-foreground">
                    暂无智能体工作区
                  </p>
                </div>
              ) : (
                <div className="pt-1">
                  {agentPartitions.primary && (
                    <section aria-labelledby="primary-agent-heading">
                      <h2
                        id="primary-agent-heading"
                        className="px-3 pb-1 pt-1 text-[10px] font-medium tracking-[0.08em] text-muted-foreground"
                      >
                        主智能体 · {agentPartitions.primary.name}
                      </h2>
                      {renderPrimaryAgentWorkspaces(agentPartitions.primary)}
                    </section>
                  )}
                  {agentPartitions.custom.length > 0 && (
                    <section
                      aria-labelledby="custom-agent-heading"
                      className="mt-4 border-t border-border/60 pt-3"
                    >
                      <h2
                        id="custom-agent-heading"
                        className="px-3 pb-1 text-[10px] font-medium tracking-[0.08em] text-muted-foreground"
                      >
                        自定义智能体
                      </h2>
                      {agentPartitions.custom.map(renderAgentSection)}
                    </section>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <CreateContainerDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />
      <RenameDialog
        open={renameState.open}
        jid={renameState.jid}
        currentName={renameState.name}
        onClose={() => setRenameState({ open: false, jid: '', name: '' })}
      />
      <ConfirmDialog
        open={clearState.open}
        onClose={closeClear}
        onConfirm={handleClearConfirm}
        title="重建工作区"
        message={`确认重建「${clearState.name}」？会永久删除全部聊天记录、上下文、所有子对话及其消息、工作目录文件，以及该工作区的全部 Memory（含版本历史、遗忘记录和 CKQClaw 称呼偏好）；Home 还会重置首次唤醒状态。关联定时任务会停止并移入回收站，运行历史与持久化目录 (data/extra/) 保留。不可撤销。`}
        confirmText="确认重建"
        confirmVariant="danger"
        loading={clearLoading}
      />
      <DeleteWorkspaceDialog
        state={deleteState}
        onClose={closeDelete}
        onConfirm={handleDeleteConfirm}
        loading={deleteLoading}
      />
    </TooltipProvider>
  );
}
