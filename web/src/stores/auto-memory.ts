import { create } from 'zustand';
import { api } from '../api/client';

/**
 * Auto-memory (mem0) management store — task W.
 *
 * Mirrors the model-pricing store conventions: load/invalidate style
 * actions, mutate-then-reload for destructive ops, and row-level failures
 * land in `actionError` without clobbering the already loaded list
 * (`error` stays the page-level list error).
 */

/** One mem0 memory as returned by the sidecar list/search ops. */
export interface AutoMemoryItem {
  id: string;
  memory: string;
  created_at?: string;
  updated_at?: string;
  metadata?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface AutoMemoryStatus {
  enabled: boolean;
  available: boolean;
  reason?: string;
}

/** UI page size; the API caps list limit at 100. */
export const AUTO_MEMORY_PAGE_SIZE = 20;

const encodedJid = (workspaceJid: string) => encodeURIComponent(workspaceJid);

interface AutoMemoryState {
  status: AutoMemoryStatus | null;
  statusLoading: boolean;
  items: AutoMemoryItem[];
  listLoading: boolean;
  /** Page-level list/search error. */
  error: string | null;
  /** Row-level (single delete / purge) failure; never replaces `items`. */
  actionError: string | null;
  /** Active search keyword ('' = plain paginated list). */
  query: string;
  offset: number;
  hasMore: boolean;

  loadStatus: (workspaceJid?: string) => Promise<AutoMemoryStatus>;
  loadMemories: (
    workspaceJid: string,
    opts?: { query?: string; offset?: number },
  ) => Promise<void>;
  deleteMemory: (workspaceJid: string, memoryId: string) => Promise<void>;
  deleteAll: (workspaceJid: string) => Promise<void>;
}

const errorMessage = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

export const useAutoMemoryStore = create<AutoMemoryState>((set, get) => ({
  status: null,
  statusLoading: false,
  items: [],
  listLoading: false,
  error: null,
  actionError: null,
  query: '',
  offset: 0,
  hasMore: false,

  loadStatus: async (workspaceJid) => {
    set({ statusLoading: true });
    try {
      const status = await api.get<AutoMemoryStatus>(
        workspaceJid
          ? `/api/auto-memory/status?workspaceJid=${encodedJid(workspaceJid)}`
          : '/api/auto-memory/status',
      );
      set({ status, statusLoading: false });
      return status;
    } catch (err) {
      const status: AutoMemoryStatus = {
        enabled: false,
        available: false,
        reason: errorMessage(err, '无法获取自动记忆状态'),
      };
      set({ status, statusLoading: false });
      return status;
    }
  },

  loadMemories: async (workspaceJid, opts) => {
    const query = opts?.query ?? get().query;
    const offset = opts?.offset ?? (query ? 0 : get().offset);
    set({ listLoading: true, error: null });
    try {
      let items: AutoMemoryItem[];
      if (query.trim()) {
        // Search has no offset — the UI caps results at one page.
        const data = await api.get<{ items: AutoMemoryItem[] }>(
          `/api/auto-memory/workspaces/${encodedJid(workspaceJid)}` +
            `/memories/search?q=${encodeURIComponent(query.trim())}` +
            `&limit=${AUTO_MEMORY_PAGE_SIZE}`,
        );
        items = data.items ?? [];
        set({
          items,
          query,
          offset: 0,
          hasMore: false,
          listLoading: false,
        });
        return;
      }
      const data = await api.get<{ items: AutoMemoryItem[] }>(
        `/api/auto-memory/workspaces/${encodedJid(workspaceJid)}` +
          `/memories?limit=${AUTO_MEMORY_PAGE_SIZE}&offset=${offset}`,
      );
      items = data.items ?? [];
      set({
        items,
        query: '',
        offset,
        hasMore: items.length === AUTO_MEMORY_PAGE_SIZE,
        listLoading: false,
      });
    } catch (err) {
      set({
        listLoading: false,
        error: errorMessage(err, '自动记忆列表加载失败'),
      });
    }
  },

  deleteMemory: async (workspaceJid, memoryId) => {
    set({ actionError: null });
    try {
      await api.delete(
        `/api/auto-memory/workspaces/${encodedJid(workspaceJid)}/memories/${encodeURIComponent(memoryId)}`,
      );
      const { query, offset } = get();
      await get().loadMemories(workspaceJid, { query, offset });
    } catch (err) {
      set({ actionError: errorMessage(err, '删除失败') });
      throw err;
    }
  },

  deleteAll: async (workspaceJid) => {
    set({ actionError: null });
    try {
      await api.delete(
        `/api/auto-memory/workspaces/${encodedJid(workspaceJid)}/memories`,
      );
      await get().loadMemories(workspaceJid, { query: '', offset: 0 });
    } catch (err) {
      set({ actionError: errorMessage(err, '清空失败') });
      throw err;
    }
  },
}));
