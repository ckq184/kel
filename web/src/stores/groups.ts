/**
 * 工作区列表 store（对应 GET /api/groups）。
 *
 * ISSUE-11 B3：本 store 是 /api/groups 拉取路径的唯一 owner（模块级
 * in-flight 去重）。chat store 的 loadGroups 委托本 loader 并把结果镜像
 * 进自身 groups（currentGroup 语义仍归 chat store）；chat store 的
 * createFlow / renameFlow / togglePin / deleteFlow 写流沿
 * updateInteractionMode 先例向本 store 确定性广播。两份 state 容器保留，
 * 组件消费面不动。
 *
 * groups 按 jid 键控；加载时经 normalizeGroupInteractionMode 归一化交互
 * 模式字段。runnerStates 是运行中工作区的本地覆盖视图（WS 广播驱动
 * setRunnerState），idle 即从表移除、不落盘。adminHostOnlyMode 来自
 * 服务端的全局只读开关，供 UI 禁用 host 执行入口。
 */
import { create } from 'zustand';
import { api } from '../api/client';
import type { GroupInfo } from '../types';
import { normalizeGroupInteractionMode } from '../lib/interaction-mode';

export type { GroupInfo };

interface GroupsState {
  groups: Record<string, GroupInfo>;
  adminHostOnlyMode: boolean;
  loading: boolean;
  error: string | null;
  runnerStates: Record<string, 'idle' | 'running'>;
  loadGroups: () => Promise<void>;
  setRunnerState: (chatJid: string, state: 'idle' | 'running') => void;
}

let loadGroupsInFlight: Promise<void> | null = null;

export const useGroupsStore = create<GroupsState>((set) => ({
  groups: {},
  adminHostOnlyMode: false,
  loading: false,
  error: null,
  runnerStates: {},

  loadGroups: async () => {
    // 同一时刻只发一个 /api/groups 请求；并发调用方共享同一 in-flight。
    if (loadGroupsInFlight) return loadGroupsInFlight;
    loadGroupsInFlight = (async () => {
      set({ loading: true });
      try {
        const data = await api.get<{
          groups: Record<string, GroupInfo>;
          admin_host_only_mode?: boolean;
        }>('/api/groups');
        const groups = Object.fromEntries(
          Object.entries(data.groups).map(([jid, group]) => [
            jid,
            normalizeGroupInteractionMode(group),
          ]),
        );
        set({
          groups,
          adminHostOnlyMode: data.admin_host_only_mode === true,
          loading: false,
          error: null,
        });
      } catch (err) {
        set({
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })().finally(() => {
      loadGroupsInFlight = null;
    });
    return loadGroupsInFlight;
  },

  setRunnerState: (chatJid: string, state: 'idle' | 'running') => {
    set((s) => {
      if (state === 'idle') {
        const { [chatJid]: _, ...rest } = s.runnerStates;
        return { runnerStates: rest };
      }
      return { runnerStates: { ...s.runnerStates, [chatJid]: state } };
    });
  },
}));
