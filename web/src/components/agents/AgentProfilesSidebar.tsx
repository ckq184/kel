import { Loader2, Plus, RefreshCw } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAgentProfilesStore } from '@/stores/agent-profiles';

// ISSUE-12 波 5 单元 5.9：档案侧栏（标题/刷新/新建/草稿项/列表与错误重试）
// 自 web/src/pages/AgentProfilesPage.tsx 原文搬运（原 669-765）。
// JSX 逐字节一致；计划偏差留痕（同 5.5）：handleSelectProfile/
// handleCreateNewAgent/handleRefreshProfiles 留守页面经同名 props 注入。

type CustomProfileRow = ReturnType<
  typeof useAgentProfilesStore.getState
>['profiles'][number];

export interface AgentProfilesSidebarProps {
  customProfiles: CustomProfileRow[];
  loading: boolean;
  profilesError: string | null;
  draftMode: boolean;
  setDraftMode: Dispatch<SetStateAction<boolean>>;
  selectedId: string | null;
  name: string;
  handleRefreshProfiles: () => void;
  handleCreateNewAgent: () => void;
  handleSelectProfile: (profileId: string) => void;
}

export function AgentProfilesSidebar(props: AgentProfilesSidebarProps) {
  const {
    customProfiles,
    loading,
    profilesError,
    draftMode,
    setDraftMode,
    selectedId,
    name,
    handleRefreshProfiles,
    handleCreateNewAgent,
    handleSelectProfile,
  } = props;

  return (
    <aside className="border-b border-border bg-muted/20 lg:sticky lg:top-0 lg:flex lg:h-dvh lg:w-72 lg:flex-none lg:flex-col lg:border-b-0 lg:border-r">
      <div className="flex items-center gap-3 px-4 py-4 lg:px-5 lg:pt-6">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold text-foreground">
            自定义智能体
          </h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {customProfiles.length} 个智能体
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={handleRefreshProfiles}
          disabled={loading}
          aria-label="刷新智能体列表"
          title="刷新智能体列表"
        >
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </Button>
        <Button size="sm" onClick={handleCreateNewAgent}>
          <Plus className="h-4 w-4" />
          新建
        </Button>
      </div>

      <nav
        aria-label="自定义智能体列表"
        className="flex gap-2 overflow-x-auto px-3 pb-4 lg:block lg:min-h-0 lg:flex-1 lg:space-y-1 lg:overflow-y-auto lg:px-4"
      >
        {draftMode && (
          <button
            className="flex min-w-[220px] items-center gap-3 rounded-lg bg-brand-50 px-3 py-2.5 text-left ring-1 ring-inset ring-primary/20 transition-colors lg:min-w-0 lg:w-full"
            onClick={() => setDraftMode(true)}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-foreground">
                {name.trim() || '新智能体草稿'}
              </span>
              <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                尚未保存
              </span>
            </span>
            <Badge variant="secondary">草稿</Badge>
          </button>
        )}
        {loading && customProfiles.length === 0 ? (
          <div className="flex min-w-48 justify-center py-8 lg:min-w-0">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : profilesError ? (
          <div className="min-w-56 space-y-3 py-4 text-center lg:min-w-0">
            <div className="text-sm text-error">{profilesError}</div>
            <Button variant="outline" size="sm" onClick={handleRefreshProfiles}>
              重试
            </Button>
          </div>
        ) : (
          customProfiles.map((profile) => {
            const active = profile.id === selectedId;
            return (
              <button
                key={profile.id}
                onClick={() => handleSelectProfile(profile.id)}
                className={`flex min-w-[220px] items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:min-w-0 lg:w-full ${
                  active && !draftMode
                    ? 'bg-brand-50 text-foreground ring-1 ring-inset ring-primary/15'
                    : 'hover:bg-accent/70'
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-foreground">
                    {profile.name}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                    {profile.identity_prompt.replace(/\s+/g, ' ').trim() ||
                      '尚未设置身份描述'}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </nav>
    </aside>
  );
}
