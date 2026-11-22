import { create } from 'zustand';
import { api } from '../api/client';

/** Mirrors src/db.ts CustomModelPricing (camelCase API projection). */
export interface ModelPricingRule {
  id: string;
  kind: 'pattern' | 'fallback';
  pattern: string;
  displayName: string;
  family: string;
  inputPricePerMTok: number;
  outputPricePerMTok: number;
  cacheReadPricePerMTok: number;
  cacheCreationPricePerMTok: number;
  reasoningPricePerMTok: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ModelPricingPreviewPricing {
  pattern: string;
  displayName: string;
  family: string;
  inputPricePerMTok: number;
  outputPricePerMTok: number;
  cacheReadPricePerMTok: number;
  cacheCreationPricePerMTok: number;
  reasoningPricePerMTok: number;
}

export interface ModelPricingPreview {
  source: 'custom' | 'builtin' | 'fallback-custom' | 'fallback-sonnet';
  rule?: ModelPricingRule;
  pricing: ModelPricingPreviewPricing;
}

interface ModelPricingRuleInput {
  kind: 'pattern' | 'fallback';
  pattern?: string;
  displayName?: string;
  family?: string;
  inputPricePerMTok?: number;
  outputPricePerMTok?: number;
  cacheReadPricePerMTok?: number;
  cacheCreationPricePerMTok?: number;
  reasoningPricePerMTok?: number;
  enabled?: boolean;
}

type ModelPricingRuleUpdates = Partial<Omit<ModelPricingRuleInput, 'kind'>>;

interface ModelPricingState {
  rules: ModelPricingRule[];
  fallback: ModelPricingRule | null;
  loading: boolean;
  error: string | null;

  loadRules: () => Promise<void>;
  createRule: (input: ModelPricingRuleInput) => Promise<void>;
  updateRule: (id: string, updates: ModelPricingRuleUpdates) => Promise<void>;
  deleteRule: (id: string) => Promise<void>;
  preview: (model: string) => Promise<ModelPricingPreview>;
}

export const useModelPricingStore = create<ModelPricingState>((set, get) => ({
  rules: [],
  fallback: null,
  loading: false,
  error: null,

  loadRules: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{
        rules: ModelPricingRule[];
        fallback: ModelPricingRule | null;
      }>('/api/pricing/rules');
      set({
        rules: data.rules ?? [],
        fallback: data.fallback ?? null,
        loading: false,
        error: null,
      });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  createRule: async (input) => {
    try {
      await api.post('/api/pricing/rules', input);
      set({ error: null });
      await get().loadRules();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  updateRule: async (id, updates) => {
    try {
      await api.patch(`/api/pricing/rules/${id}`, updates);
      set({ error: null });
      await get().loadRules();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  deleteRule: async (id) => {
    try {
      await api.delete(`/api/pricing/rules/${id}`);
      set({ error: null });
      await get().loadRules();
    } catch (err) {
      // A row-level failure must not replace the already loaded list with
      // the page-level loading error state. The card reports it inline.
      throw err;
    }
  },

  preview: (model) =>
    api.post<ModelPricingPreview>('/api/pricing/preview', { model }),
}));
