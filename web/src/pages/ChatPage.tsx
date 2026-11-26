import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useChatStore } from '../stores/chat';
import { useAuthStore } from '../stores/auth';
import { useGroupsStore } from '../stores/groups';
import { ChatView } from '../components/chat/ChatView';
import { ChatGroupItem } from '../components/chat/ChatGroupItem';
import { DeleteWorkspaceDialog } from '../components/chat/DeleteWorkspaceDialog';
import { AgentWorkspaceGroup } from '../components/layout/AgentWorkspaceGroup';
import { ConfirmDialog } from '../components/common';
import { UserMenuPopover } from '../components/common/UserMenuPopover';
import { CreateContainerDialog } from '../components/chat/CreateContainerDialog';
import { RenameDialog } from '../components/chat/RenameDialog';
import { useSwipeBack } from '../hooks/useSwipeBack';
import { useClearWorkspace } from '../hooks/useClearWorkspace';
import { useAgentWorkspaceSections } from '../hooks/useAgentWorkspaceSections';
import {
  getAgentNavigationTargets,
  getPrimaryAgentWorkspaceRows,
  isAgentSectionCollapsible,
} from '../utils/agent-product';
import { useDeleteWorkspace } from '../hooks/useDeleteWorkspace';

export function ChatPage() {
  const { groupFolder } = useParams<{ groupFolder?: string }>();
  const navigate = useNavigate();
  // 窄 selector：整 store 订阅会让整个页面跟着流式输出每帧重渲染。
  const groups = useChatStore((s) => s.groups);
  const currentGroup = useChatStore((s) => s.currentGroup);
  const selectGroup = useChatStore((s) => s.selectGroup);
  const loadGroups = useChatStore((s) => s.loadGroups);
  const togglePin = useChatStore((s) => s.togglePin);
  const {
    clearState,
    clearLoading,
    openClear,
    closeClear,
    handleClearConfirm,
  } = useClearWorkspace();
  const [createOpen, setCreateOpen] = useState(false);
  const [renameState, setRenameState] = useState({
    open: false,
    jid: '',
    name: '',
  });
  const {
    deleteState,
    deleteLoading,
    openDelete,
    closeDelete,
    handleDeleteConfirm,
  } = useDeleteWorkspace({
    onDeleted: () => navigate('/chat', { replace: true }),
  });
  const appearance = useAuthStore((s) => s.appearance);

  const routeGroupJid = useMemo(() => {
    if (!groupFolder) return null;
    const entry =
      Object.entries(groups).find(
        ([jid, info]) =>
          info.folder === groupFolder &&
          jid.startsWith('web:') &&
          !!info.is_home,
      ) ||
      Object.entries(groups).find(
        ([jid, info]) => info.folder === groupFolder && jid.startsWith('web:'),
      ) ||
      Object.entries(groups).find(([_, info]) => info.folder === groupFolder);
    return entry?.[0] || null;
  }, [groupFolder, groups]);
  const runnerStates = useGroupsStore((s) => s.runnerStates);
  const hasGroups = Object.keys(groups).length > 0;

  // 移动端唯一的工作区列表入口：桌面侧边栏改为条件挂载后，/chat 落地页
  // 不再有其他组件触发 loadGroups（store 内部有 in-flight 去重，桌面端
  // 与侧边栏的并发调用只会发一个请求）。
  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  // Mobile and desktop share the same Agent-first navigation contract.
  const { agentSections, agentPartitions } = useAgentWorkspaceSections(groups);
  const hasAnyGroup = agentSections.length > 0;

  // Sync URL param to store selection. No auto-redirect to home container —
  // users land on the welcome screen and choose a container manually.
  useEffect(() => {
    if (!groupFolder) return;
    if (routeGroupJid && currentGroup !== routeGroupJid) {
      selectGroup(routeGroupJid);
      return;
    }
    if (hasGroups && !routeGroupJid) {
      // Group not found — may be newly created (task workspace). Retry once after refresh.
      loadGroups().then(() => {
        const freshGroups = useChatStore.getState().groups;
        const found = Object.entries(freshGroups).find(
          ([jid, info]) =>
            info.folder === groupFolder && jid.startsWith('web:'),
        );
        if (found) {
          selectGroup(found[0]);
        } else {
          navigate('/chat', { replace: true });
        }
      });
    }
  }, [
    groupFolder,
    routeGroupJid,
    hasGroups,
    currentGroup,
    selectGroup,
    navigate,
    loadGroups,
  ]);

  const activeGroupJid = groupFolder ? routeGroupJid : currentGroup;
  const chatViewRef = useRef<HTMLDivElement>(null);

  const handleBackToList = () => {
    navigate('/chat');
  };

  useSwipeBack(chatViewRef, handleBackToList);

  const renderMobileAgentSection = (
    section: (typeof agentSections)[number],
  ) => {
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
          if (!directGroup) return;
          selectGroup(directGroup.jid);
          navigate(`/chat/${directGroup.folder}?sessions=1`);
        }}
        onRebuild={
          directGroup?.is_my_home && directGroup.can_modify
            ? () => openClear(directGroup.jid, section.name)
            : undefined
        }
      >
        {workspaces.map((workspace) => (
          <ChatGroupItem
            key={workspace.jid}
            jid={workspace.jid}
            name={workspace.name}
            folder={workspace.folder}
            isActive={currentGroup === workspace.jid}
            isHome={false}
            isPinned={!!workspace.pinned_at}
            isRunning={runnerStates[workspace.jid] === 'running'}
            canModify={workspace.can_modify}
            onSelect={(jid, folder) => {
              selectGroup(jid);
              navigate(`/chat/${folder}?sessions=1`);
            }}
            onRename={(jid, name) => setRenameState({ open: true, jid, name })}
            onClearHistory={openClear}
            onDelete={openDelete}
            onTogglePin={(jid) => void togglePin(jid)}
          />
        ))}
      </AgentWorkspaceGroup>
    );
  };

  const renderMobilePrimaryAgentWorkspaces = (
    section: (typeof agentSections)[number],
  ) => {
    const workspaces = getPrimaryAgentWorkspaceRows(section);
    const selectWorkspace = (jid: string, folder: string) => {
      selectGroup(jid);
      navigate(`/chat/${folder}?sessions=1`);
    };

    return (
      <div data-hc-primary-agent-workspaces={section.id}>
        {workspaces.map((workspace) => (
          <ChatGroupItem
            key={workspace.jid}
            jid={workspace.jid}
            name={workspace.name}
            folder={workspace.folder}
            isActive={currentGroup === workspace.jid}
            isHome={!!workspace.is_my_home}
            isPinned={!!workspace.pinned_at}
            isRunning={runnerStates[workspace.jid] === 'running'}
            canModify={workspace.can_modify}
            onSelect={selectWorkspace}
            onRename={(jid, name) => setRenameState({ open: true, jid, name })}
            onClearHistory={openClear}
            onDelete={openDelete}
            onTogglePin={(jid) => void togglePin(jid)}
          />
        ))}
      </div>
    );
  };

  return (
    <div className="h-full flex bg-muted/30">
      {/* Mobile workspace list when no group selected */}
      {!groupFolder && (
        <div className="block lg:hidden w-full overflow-y-auto">
          {/* Mobile header: horizontal logo + actions */}
          <div className="flex items-center gap-3 px-4 pt-5 pb-3">
            <img
              src={`${import.meta.env.BASE_URL}icons/logo-text.svg`}
              alt={appearance?.appName || 'CKQClaw'}
              className="h-8"
            />
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="grid h-10 w-10 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
              title="新建工作区"
              aria-label="新建工作区"
            >
              <Plus className="h-5 w-5" />
            </button>
            <UserMenuPopover side="bottom" ariaLabel="用户菜单" />
          </div>
          {hasAnyGroup ? (
            <div className="px-2 pb-nav-safe">
              {agentPartitions.primary && (
                <section aria-labelledby="mobile-primary-agent-heading">
                  <h2
                    id="mobile-primary-agent-heading"
                    className="px-3 pb-1 pt-1 text-[10px] font-medium tracking-[0.08em] text-muted-foreground"
                  >
                    主智能体 · {agentPartitions.primary.name}
                  </h2>
                  {renderMobilePrimaryAgentWorkspaces(agentPartitions.primary)}
                </section>
              )}
              {agentPartitions.custom.length > 0 && (
                <section
                  aria-labelledby="mobile-custom-agent-heading"
                  className="mt-4 border-t border-border/60 pt-3"
                >
                  <h2
                    id="mobile-custom-agent-heading"
                    className="px-3 pb-1 text-[10px] font-medium tracking-[0.08em] text-muted-foreground"
                  >
                    自定义智能体
                  </h2>
                  {agentPartitions.custom.map(renderMobileAgentSection)}
                </section>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-64 px-4">
              <img
                src={`${import.meta.env.BASE_URL}icons/logo-text.svg`}
                alt={appearance?.appName || 'CKQClaw'}
                className="h-12 mb-6"
              />
              <p className="text-muted-foreground text-sm">暂无智能体工作区</p>
            </div>
          )}
        </div>
      )}

      {/* Chat View - Desktop: visible when active group exists, Mobile: only in detail route */}
      {activeGroupJid ? (
        <div
          ref={chatViewRef}
          className={`${groupFolder ? 'flex-1 min-w-0 h-full overflow-hidden lg:pt-4' : 'hidden lg:block flex-1 min-w-0 h-full overflow-hidden lg:pt-4'}`}
        >
          <ChatView groupJid={activeGroupJid} onBack={handleBackToList} />
        </div>
      ) : (
        <div className="hidden lg:flex flex-1 items-center justify-center bg-background rounded-t-3xl rounded-b-none mt-5 mr-5 mb-0 ml-3 relative">
          <div className="text-center max-w-sm">
            {/* Logo */}
            <div className="w-16 h-16 rounded-2xl overflow-hidden mx-auto mb-6">
              <img
                src={`${import.meta.env.BASE_URL}icons/icon-192.png`}
                alt="CKQClaw"
                className="w-full h-full object-cover"
              />
            </div>
            <h2 className="text-xl font-semibold text-foreground mb-2">
              欢迎使用 {appearance?.appName || 'CKQClaw'}
            </h2>
            <p className="text-muted-foreground text-sm">
              从左侧选择一个工作区开始对话
            </p>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={clearState.open}
        onClose={closeClear}
        onConfirm={handleClearConfirm}
        title="重建工作区"
        message={`确认重建工作区「${clearState.name}」吗？这会永久删除全部聊天记录、上下文、所有子对话及其消息、工作目录文件，以及该工作区的全部 Memory（含版本历史、遗忘记录和 CKQClaw 称呼偏好）；Home 还会重置首次唤醒状态。关联定时任务会停止并移入回收站，运行历史保留；持久化目录 (data/extra/) 保留。此操作不可撤销。`}
        confirmText="确认重建"
        cancelText="取消"
        confirmVariant="danger"
        loading={clearLoading}
      />
      <RenameDialog
        open={renameState.open}
        jid={renameState.jid}
        currentName={renameState.name}
        onClose={() => setRenameState({ open: false, jid: '', name: '' })}
      />
      <DeleteWorkspaceDialog
        state={deleteState}
        onClose={closeDelete}
        onConfirm={handleDeleteConfirm}
        loading={deleteLoading}
      />
      <CreateContainerDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(jid, folder) => {
          selectGroup(jid);
          navigate(`/chat/${folder}?sessions=1`);
        }}
      />
    </div>
  );
}
