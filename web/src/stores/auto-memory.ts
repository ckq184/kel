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
  /** Which channel owns the config (task X): env wins over file. */
  source?: AutoMemoryConfigSource;
}

/** Masked credential view for one endpoint (GET /api/auto-memory/config). */
export interface AutoMemoryEndpointView {
  baseUrl: string;
  model: string;
  apiKeyMasked: string;
}

export type AutoMemoryConfigSource = 'env' | 'file' | 'none';

export interface AutoMemoryConfig {
  source: AutoMemoryConfigSource;
  enabled: boolean;
  llm?: AutoMemoryEndpointView;
  embedder?: AutoMemoryEndpointView;
}

/** Chat-capture cost preview (task Y) — counts/chars of what would be sent. */
export interface AutoMemoryCapturePreview {
  messages: number;
  chars: number;
}

/** Chat-capture receipt (task Y) — counts summarized from the mem0 add. */
export interface AutoMemoryCaptureReceipt {
  ok: boolean;
  captured: number;
  added: number;
  intercepted: number;
}

/**
 * PUT payload — apiKey 空串或掩码原样回传都表示保留旧值；只有非掩码新值
 * 才会覆盖（服务端解析，前端只透传输入框内容）。
 */
export interface AutoMemoryConfigInput {
  llm: { baseUrl: string; apiKey: string; model: string };
  embedder: { baseUrl: string; apiKey: string; model: string };
}

/** UI page size; the API caps list limit at 100. */
export const AUTO_MEMORY_PAGE_SIZE = 20;

/** 提炼一次 60k 字全文可能需 10-60s，默认 8s 请求超时会误杀（任务 Y）。 */
export const AUTO_MEMORY_CAPTURE_TIMEOUT_MS = 90_000;

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
  /** Endpoint config view (task X) — masked keys only. */
  config: AutoMemoryConfig | null;
  configLoading: boolean;
  /** Page-level config load error. */
  configError: string | null;

  loadStatus: (workspaceJid?: string) => Promise<AutoMemoryStatus>;
  loadMemories: (
    workspaceJid: string,
    opts?: { query?: string; offset?: number },
  ) => Promise<void>;
  deleteMemory: (workspaceJid: string, memoryId: string) => Promise<void>;
  deleteAll: (workspaceJid: string) => Promise<void>;
  loadConfig: () => Promise<AutoMemoryConfig | null>;
  saveConfig: (input: AutoMemoryConfigInput) => Promise<void>;
  clearConfig: () => Promise<void>;
  previewCapture: (
    workspaceJid: string,
    agentIds: string[],
  ) => Promise<AutoMemoryCapturePreview>;
  captureConversation: (
    workspaceJid: string,
    agentIds: string[],
  ) => Promise<AutoMemoryCaptureReceipt>;
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
  config: null,
  configLoading: false,
  configError: null,

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

  // ── Config channel (task X) ────────────────────────────────────────────
  loadConfig: async () => {
    set({ configLoading: true, configError: null });
    try {
      const config = await api.get<AutoMemoryConfig>('/api/auto-memory/config');
      set({ config, configLoading: false });
      return config;
    } catch (err) {
      set({
        configLoading: false,
        configError: errorMessage(err, '自动记忆端点配置加载失败'),
      });
      return null;
    }
  },

  saveConfig: async (input) => {
    set({ actionError: null });
    try {
      await api.put<{ ok: boolean; sidecarsRestarted: boolean }>(
        '/api/auto-memory/config',
        input,
      );
      await get().loadConfig();
    } catch (err) {
      set({ actionError: errorMessage(err, '保存自动记忆端点配置失败') });
      throw err;
    }
  },

  clearConfig: async () => {
    set({ actionError: null });
    try {
      await api.delete<{ ok: boolean; sidecarsRestarted: boolean }>(
        '/api/auto-memory/config',
      );
      await get().loadConfig();
    } catch (err) {
      set({ actionError: errorMessage(err, '清除自动记忆端点配置失败') });
      throw err;
    }
  },

  // ── Chat capture channel (task Y, multi-session merge in task Y2) ─────
  previewCapture: async (workspaceJid, agentIds) => {
    set({ actionError: null });
    try {
      // Repeated `agentId` params; '' marks the main conversation. An empty
      // selection sends no param (= main-only, same server semantics).
      const query = agentIds.length
        ? `?${agentIds.map((id) => `agentId=${encodeURIComponent(id)}`).join('&')}`
        : '';
      return await api.get<AutoMemoryCapturePreview>(
        `/api/auto-memory/workspaces/${encodedJid(workspaceJid)}/capture/preview${query}`,
      );
    } catch (err) {
      set({ actionError: errorMessage(err, '获取提炼预览失败') });
      throw err;
    }
  },

  captureConversation: async (workspaceJid, agentIds) => {
    set({ actionError: null });
    try {
      return await api.post<AutoMemoryCaptureReceipt>(
        `/api/auto-memory/workspaces/${encodedJid(workspaceJid)}/capture`,
        { agentIds },
        AUTO_MEMORY_CAPTURE_TIMEOUT_MS,
      );
    } catch (err) {
      set({ actionError: errorMessage(err, '提炼记忆失败') });
      throw err;
    }
  },
}));
