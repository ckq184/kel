import { create } from 'zustand';
import { api } from '../api/client';

export interface SystemStatus {
  activeContainers: number;
  activeHostProcesses?: number;
  activeTotal?: number;
  maxConcurrentContainers: number;
  queueLength: number;
  uptime: number;
  dockerImageExists: boolean;
  dockerRequired?: boolean;
  adminHostOnlyMode?: boolean;
  dockerPullInProgress?: boolean;
  piRuntimeVersions?: {
    host: string | null;
    container: string | null;
    latest: string | null;
  } | null;
  dockerPullLogs?: string[];
  dockerPullResult?: { success: boolean; error?: string } | null;
  groups: Array<{
    jid: string;
    active: boolean;
    pendingMessages: boolean;
    pendingTasks: number;
    containerName: string | null;
    displayName: string | null;
    groupFolder: string | null;
    ownerUsername: string | null;
    selectedProviderId: string | null;
    selectedProviderName: string | null;
  }>;
}

/** GET /api/status/channel-outbox/uncertain 返回的行（后端刻意省略 payload，
 * 只给身份与路由信息用于人工对账）。 */
export interface UncertainChannelOutboxItem {
  id: string;
  turnRunId: string;
  kind: 'text' | 'image' | 'file' | 'card' | 'mutation';
  ordinal: number;
  revision: number;
  provider: string;
  accountId: string;
  chatId: string | null;
  attempt: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export type UncertainOutboxResolution = 'delivered' | 'failed';

interface UncertainOutboxListResponse {
  items: UncertainChannelOutboxItem[];
  total: number;
}

interface MonitorState {
  status: SystemStatus | null;
  loading: boolean;
  error: string | null;
  pulling: boolean;
  pullLogs: string[];
  pullResult: {
    success: boolean;
    error?: string;
    stdout?: string;
    stderr?: string;
  } | null;
  uncertainItems: UncertainChannelOutboxItem[];
  uncertainError: string | null;
  loadStatus: () => Promise<void>;
  pullDockerImage: () => Promise<void>;
  clearPullResult: () => void;
  loadUncertainOutbox: () => Promise<void>;
  resolveUncertainOutbox: (
    id: string,
    resolution: UncertainOutboxResolution,
    expectedRevision: number,
    providerMessageId?: string,
  ) => Promise<void>;
}

export const useMonitorStore = create<MonitorState>((set, get) => ({
  status: null,
  loading: false,
  error: null,
  pulling: false,
  pullLogs: [],
  pullResult: null,
  uncertainItems: [],
  uncertainError: null,

  loadStatus: async () => {
    set({ loading: true });
    try {
      const status = await api.get<SystemStatus>('/api/status');
      const update: Partial<MonitorState> = {
        status,
        loading: false,
        error: null,
      };
      const state = useMonitorStore.getState();
      if (status.dockerPullInProgress && !state.pulling) {
        // 后端正在拉取，但前端不知道（页面刷新后恢复）
        update.pulling = true;
        // 恢复日志（仅当本地无日志时）
        if (
          state.pullLogs.length === 0 &&
          status.dockerPullLogs &&
          status.dockerPullLogs.length > 0
        ) {
          update.pullLogs = status.dockerPullLogs;
        }
      } else if (!status.dockerPullInProgress && state.pulling) {
        // 后端拉取已结束，同步重置
        update.pulling = false;
        // 恢复结果
        if (status.dockerPullResult) {
          update.pullResult = status.dockerPullResult;
        }
      }
      set(update);
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  pullDockerImage: async () => {
    set({ pulling: true, pullLogs: [], pullResult: null });
    try {
      await api.post('/api/docker/pull', {});
      // POST returns 202 immediately; progress comes via WebSocket
    } catch (err) {
      set({
        pulling: false,
        pullResult: {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  },

  clearPullResult: () => set({ pullResult: null, pullLogs: [] }),

  loadUncertainOutbox: async () => {
    try {
      const data = await api.get<UncertainOutboxListResponse>(
        '/api/status/channel-outbox/uncertain',
      );
      set({ uncertainItems: data.items ?? [], uncertainError: null });
    } catch (err) {
      // 与 loadStatus 相同的失败策略：记录错误信息，不中断轮询
      set({
        uncertainError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  resolveUncertainOutbox: async (
    id,
    resolution,
    expectedRevision,
    providerMessageId,
  ) => {
    const body: {
      resolution: UncertainOutboxResolution;
      expectedRevision: number;
      providerMessageId?: string;
    } = { resolution, expectedRevision };
    if (resolution === 'delivered') {
      const trimmed = providerMessageId?.trim() ?? '';
      if (!trimmed) {
        throw new Error('标记已投递前必须填写渠道消息 ID（providerMessageId）');
      }
      body.providerMessageId = trimmed;
    }
    try {
      await api.post(`/api/status/channel-outbox/${id}/resolve`, body);
    } catch (err) {
      if ((err as { status?: number } | null)?.status !== 409) throw err;
      // 409：CAS 失败（revision 过期或已被他人裁决）。不能盲目重试，
      // 先重读列表拿到最新 revision，由操作者重新决定。
      await get().loadUncertainOutbox();
      throw err;
    }
    // 成功后立即重读列表，让已放行的行从围栏列表消失
    await get().loadUncertainOutbox();
  },
}));
