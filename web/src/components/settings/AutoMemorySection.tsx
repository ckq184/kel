import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  BrainCircuit,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/api/client';
import { ConfirmDialog } from '../common/ConfirmDialog';
import {
  useAutoMemoryStore,
  AUTO_MEMORY_PAGE_SIZE,
  type AutoMemoryItem,
} from '../../stores/auto-memory';
import type { WorkspaceSummary } from '@/features/workspace-memory/model';

/**
 * 自动记忆管理分区（任务 W）。
 *
 * 状态卡三态降级：未配置（enabled=false，展示 data/config/auto-memory.json
 * 配置引导，不渲染管理区）/ 已启用 / 侧车不可用（available === false，展示
 * reason，管理操作禁用）。自动记忆的管理调用全部经 useAutoMemoryStore，
 * 本组件只经 /api/workspaces 取工作区清单。
 */
export function AutoMemorySection() {
  const {
    status,
    statusLoading,
    items,
    listLoading,
    error,
    actionError,
    query,
    offset,
    hasMore,
    loadStatus,
    loadMemories,
    deleteMemory,
    deleteAll,
  } = useAutoMemoryStore();

  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(true);
  const [selectedJid, setSelectedJid] = useState<string>('');
  const [searchInput, setSearchInput] = useState('');
  const [deleting, setDeleting] = useState<AutoMemoryItem | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeBusy, setPurgeBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setWorkspacesLoading(true);
    apiWorkspaces()
      .then((loaded) => {
        if (cancelled) return;
        setWorkspaces(loaded);
        const preferred =
          loaded.find((workspace) => workspace.is_home) ?? loaded[0];
        if (preferred) setSelectedJid(preferred.jid);
      })
      .catch(() => {
        if (!cancelled) setWorkspaces([]);
      })
      .finally(() => {
        if (!cancelled) setWorkspacesLoading(false);
      });
    void loadStatus();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedJid) return;
    void loadStatus(selectedJid);
    void loadMemories(selectedJid, { query: '', offset: 0 });
  }, [selectedJid, loadStatus, loadMemories]);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.jid === selectedJid),
    [workspaces, selectedJid],
  );

  const handleSearch = useCallback(() => {
    if (!selectedJid) return;
    void loadMemories(selectedJid, { query: searchInput, offset: 0 });
  }, [selectedJid, searchInput, loadMemories]);

  const handleClearSearch = useCallback(() => {
    setSearchInput('');
    if (!selectedJid) return;
    void loadMemories(selectedJid, { query: '', offset: 0 });
  }, [selectedJid, loadMemories]);

  const handlePage = useCallback(
    (delta: number) => {
      if (!selectedJid) return;
      void loadMemories(selectedJid, {
        query,
        offset: Math.max(0, offset + delta * AUTO_MEMORY_PAGE_SIZE),
      });
    },
    [selectedJid, query, offset, loadMemories],
  );

  const handleDelete = async () => {
    if (!deleting || !selectedJid) return;
    setDeleteBusy(true);
    try {
      await deleteMemory(selectedJid, deleting.id);
      toast.success('已删除该条记忆');
      setDeleting(null);
    } catch {
      // actionError 已由 store 记录，列表内联展示。
    } finally {
      setDeleteBusy(false);
    }
  };

  const handlePurge = async () => {
    if (!selectedJid) return;
    setPurgeBusy(true);
    try {
      await deleteAll(selectedJid);
      toast.success('已清空该工作区的自动记忆');
      setPurgeOpen(false);
    } catch {
      // actionError 已由 store 记录，列表内联展示。
    } finally {
      setPurgeBusy(false);
    }
  };

  const handleRetryStatus = () => {
    void loadStatus(selectedJid || undefined);
  };

  // ── 状态卡（三态） ─────────────────────────────────────────────
  if (statusLoading && !status) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        正在获取自动记忆状态…
      </div>
    );
  }

  if (status && status.enabled === false) {
    return (
      <div className="rounded-xl border border-border bg-muted/30 p-6 text-sm leading-6 text-muted-foreground">
        <div className="mb-2 flex items-center gap-2 font-medium text-foreground">
          <BrainCircuit className="size-4 text-primary" />
          自动记忆未启用
        </div>
        <p>
          自动记忆由宿主机 mem0 侧车提供，需要在宿主机配置文件{' '}
          <code className="rounded bg-muted px-1 font-mono text-xs">
            data/config/auto-memory.json
          </code>{' '}
          中提供成对的 llm 与 embedder OpenAI 兼容端点（baseUrl / apiKey /
          model），或通过环境变量 CKQCLAW_AUTO_MEMORY 提供。配置前，Agent
          的自动记忆工具与管理界面均不可用。
        </p>
        <p className="mt-2">
          数据保存在本机（Qdrant
          local，按工作区目录隔离），不会上传到任何云端服务。
        </p>
      </div>
    );
  }

  if (status && status.available === false) {
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-2 rounded-xl border border-warning/20 bg-warning-bg px-4 py-3 text-sm text-warning">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0">
            <div className="font-medium">自动记忆侧车当前不可用</div>
            {status.reason && (
              <div className="mt-1 break-all text-xs opacity-80">
                {status.reason}
              </div>
            )}
            <div className="mt-1 text-xs opacity-80">
              管理操作已禁用；恢复后可重试。
            </div>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={handleRetryStatus}>
          <RefreshCw className="size-3.5" />
          重试
        </Button>
      </div>
    );
  }

  // ── 已启用：管理区 ─────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        <BrainCircuit className="mt-0.5 size-4 shrink-0 text-primary" />
        自动记忆已启用：数据保存在本机，按工作区隔离；以下操作直接作用于 mem0
        向量库，删除与清空不可恢复。
      </div>

      {workspacesLoading ? (
        <div className="text-sm text-muted-foreground">加载工作区列表中…</div>
      ) : workspaces.length === 0 ? (
        <div className="text-sm text-muted-foreground">暂无可用工作区。</div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="选择工作区"
              value={selectedJid}
              onChange={(event) => {
                setSearchInput('');
                setSelectedJid(event.target.value);
              }}
              className="h-9 min-w-56 rounded-lg border border-border bg-background px-3 text-sm text-foreground"
            >
              {workspaces.map((workspace) => (
                <option key={workspace.jid} value={workspace.jid}>
                  {workspace.name || workspace.jid}
                  {workspace.is_home ? '（主工作区）' : ''}
                </option>
              ))}
            </select>

            <div className="flex items-center gap-1">
              <input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') handleSearch();
                }}
                placeholder="搜索记忆关键字"
                className="h-9 w-56 rounded-lg border border-border bg-background px-3 text-sm text-foreground"
              />
              <Button size="sm" variant="outline" onClick={handleSearch}>
                <Search className="size-3.5" />
                搜索
              </Button>
              {query && (
                <Button size="sm" variant="ghost" onClick={handleClearSearch}>
                  清除
                </Button>
              )}
            </div>

            <Button
              size="sm"
              variant="destructive"
              className="ml-auto"
              onClick={() => setPurgeOpen(true)}
              disabled={!selectedWorkspace || listLoading}
            >
              <Trash2 className="size-3.5" />
              清空全部
            </Button>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              {error}
            </div>
          )}
          {actionError && !error && (
            <div className="flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              {actionError}
            </div>
          )}

          <div className="rounded-xl border border-border overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/50">
              <div className="text-sm font-medium text-foreground">
                {query ? `搜索结果（关键字：${query}）` : '记忆列表'}
              </div>
              <span className="text-xs text-muted-foreground">
                {listLoading ? '加载中…' : `${items.length} 条`}
              </span>
            </div>

            {items.length === 0 && !listLoading ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                {query ? '没有匹配的记忆。' : '该工作区还没有自动记忆。'}
              </div>
            ) : (
              <div className="divide-y divide-border">
                {items.map((item) => (
                  <MemoryRow
                    key={item.id}
                    item={item}
                    onDelete={() => setDeleting(item)}
                  />
                ))}
              </div>
            )}

            {!query && (offset > 0 || hasMore) && (
              <div className="flex items-center justify-between border-t border-border px-4 py-2 text-sm">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={offset === 0 || listLoading}
                  onClick={() => handlePage(-1)}
                >
                  上一页
                </Button>
                <span className="text-xs text-muted-foreground">
                  第 {Math.floor(offset / AUTO_MEMORY_PAGE_SIZE) + 1} 页
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!hasMore || listLoading}
                  onClick={() => handlePage(1)}
                >
                  下一页
                </Button>
              </div>
            )}
          </div>
        </>
      )}

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        title="删除这条记忆？"
        message={
          deleting
            ? `将删除：${deleting.memory.slice(0, 120)}\n该操作立即生效且不可恢复。`
            : ''
        }
        confirmText="删除"
        confirmVariant="danger"
        loading={deleteBusy}
      />
      <ConfirmDialog
        open={purgeOpen}
        onClose={() => setPurgeOpen(false)}
        onConfirm={handlePurge}
        title="清空全部自动记忆？"
        message={`将删除工作区「${selectedWorkspace?.name || selectedJid}」的全部自动记忆（${
          query ? '含未在搜索结果中显示的条目' : `当前显示 ${items.length} 条`
        }）。该操作不可恢复。`}
        confirmText="全部删除"
        confirmVariant="danger"
        loading={purgeBusy}
      />
    </div>
  );
}

function MemoryRow({
  item,
  onDelete,
}: {
  item: AutoMemoryItem;
  onDelete: () => void;
}) {
  const sessionId =
    item.metadata && typeof item.metadata.sessionId === 'string'
      ? item.metadata.sessionId
      : null;
  const turnId =
    item.metadata && typeof item.metadata.turnId === 'string'
      ? item.metadata.turnId
      : null;

  return (
    <div className="flex items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className="break-words text-sm text-foreground">{item.memory}</div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {item.created_at && (
            <span>{new Date(item.created_at).toLocaleString()}</span>
          )}
          {sessionId && (
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono">
              session {sessionId.slice(0, 12)}
            </span>
          )}
          {turnId && (
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono">
              turn {turnId.slice(0, 12)}
            </span>
          )}
        </div>
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={onDelete}
        aria-label="删除这条记忆"
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}

/** Workspace picker source — same projection the Workspace Memory page uses. */
async function apiWorkspaces(): Promise<WorkspaceSummary[]> {
  const data = await api.get<{ workspaces: WorkspaceSummary[] }>(
    '/api/workspaces',
  );
  return data.workspaces ?? [];
}
