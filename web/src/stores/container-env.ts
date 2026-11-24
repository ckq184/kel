/**
 * 工作区容器环境配置 store（对应 /api/groups/:jid/env）。
 *
 * 凭据安全：后端只回传掩码（*Masked）与存在性（has*），明文 token 仅在
 * 保存时提交、永不回显。configs 按 jid 缓存多份工作区配置。
 */
import { create } from 'zustand';
import { api } from '../api/client';

export interface ContainerEnvPublicConfig {
  anthropicBaseUrl: string;
  anthropicAuthTokenMasked: string | null;
  anthropicApiKeyMasked: string | null;
  hasAnthropicAuthToken: boolean;
  hasAnthropicApiKey: boolean;
  anthropicModel: string;
  customEnv: Record<string, string>;
}

interface ContainerEnvState {
  configs: Record<string, ContainerEnvPublicConfig>;
  loading: boolean;
  saving: boolean;
  error: string | null;

  loadConfig: (jid: string) => Promise<void>;
  saveConfig: (
    jid: string,
    data: {
      anthropicBaseUrl?: string;
      anthropicAuthToken?: string;
      anthropicApiKey?: string;
      anthropicModel?: string;
      customEnv?: Record<string, string>;
    },
  ) => Promise<boolean>;
}

export const useContainerEnvStore = create<ContainerEnvState>((set) => ({
  configs: {},
  loading: false,
  saving: false,
  error: null,

  loadConfig: async (jid: string) => {
    set({ loading: true, error: null });
    try {
      const data = await api.get<ContainerEnvPublicConfig>(
        `/api/groups/${encodeURIComponent(jid)}/env`,
      );
      set((s) => ({
        configs: { ...s.configs, [jid]: data },
        loading: false,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load config';
      console.error('Failed to load container env config:', err);
      set({ loading: false, error: msg });
    }
  },

  saveConfig: async (jid, data) => {
    set({ saving: true, error: null });
    try {
      const result = await api.put<ContainerEnvPublicConfig>(
        `/api/groups/${encodeURIComponent(jid)}/env`,
        data,
      );
      set((s) => ({
        configs: { ...s.configs, [jid]: result },
        saving: false,
        error: null,
      }));
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save config';
      console.error('Failed to save container env config:', err);
      set({ saving: false, error: msg });
      return false;
    }
  },
}));
