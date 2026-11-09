import fs from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../web/src/api/client', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { api } from '../web/src/api/client';
import { useModelPricingStore } from '../web/src/stores/model-pricing';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf-8');

describe('model pricing settings tab registration', () => {
  test('registers the pricing tab in all five settings surfaces', () => {
    const types = read('web/src/components/settings/types.ts');
    const page = read('web/src/pages/SettingsPage.tsx');
    const nav = read('web/src/components/settings/SettingsNav.tsx');

    // 1. SettingsTab union
    expect(types).toMatch(/\|\s*'pricing'/);
    // 2. VALID_TABS + 3. SYSTEM_TABS (manage_system_config gated)
    const validTabs = page.match(
      /const VALID_TABS:[\s\S]*?=\s*\[([\s\S]*?)\];/,
    )?.[1];
    expect(validTabs).toContain("'pricing'");
    const systemTabs = page.match(
      /const SYSTEM_TABS:[\s\S]*?=\s*\[([\s\S]*?)\];/,
    )?.[1];
    expect(systemTabs).toContain("'pricing'");
    // 4. section title map
    expect(page).toContain("pricing: '模型单价'");
    // 5. nav item with the Coins icon
    expect(nav).toContain("key: 'pricing'");
    expect(nav).toContain("label: '模型单价'");
    expect(nav).toContain('Coins');
    // render branch mounts the section
    expect(page).toContain('<ModelPricingSection />');
  });

  test('information-architecture assertions stay in sync with the new tab', () => {
    const ia = read('tests/frontend-settings-information-architecture.test.ts');
    expect(ia).toContain('expect(nav).toContain("key: \'pricing\'")');
  });
});

describe('model pricing section and dialog surface', () => {
  test('section shows the fallback card, rule list, and preview affordances', () => {
    const section = read('web/src/components/settings/ModelPricingSection.tsx');
    expect(section).toContain('兜底价');
    expect(section).toContain('未设置');
    expect(section).toContain('Sonnet');
    expect(section).toContain('useModelPricingStore');
    expect(section).toContain('ConfirmDialog');
    expect(section).toContain('confirmVariant="danger"');
    expect(section).not.toContain('/api/pricing/rules'); // 全部经 store，不直连 API
  });

  test('dialog edits five per-MTok prices with numeric inputs and preview', () => {
    const dialog = read('web/src/components/settings/ModelPricingDialog.tsx');
    expect(dialog).toContain('type="number"');
    // 五个价格字段经 PRICE_FIELDS 数组循环渲染，step 字面只需出现一次。
    expect(dialog).toContain('step="0.001"');
    for (const field of [
      'inputPricePerMTok',
      'outputPricePerMTok',
      'cacheReadPricePerMTok',
      'cacheCreationPricePerMTok',
      'reasoningPricePerMTok',
    ]) {
      expect(dialog).toContain(field);
    }
    expect(dialog).toContain('预览匹配');
  });
});

describe('model pricing store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useModelPricingStore.setState({
      rules: [],
      fallback: null,
      loading: false,
      error: null,
    });
  });

  const rule = {
    id: 'cmp_test',
    kind: 'pattern' as const,
    pattern: 'glm-5.3-flash',
    displayName: 'GLM 5.3 Flash',
    family: 'zhipu',
    inputPricePerMTok: 0.6,
    outputPricePerMTok: 2.2,
    cacheReadPricePerMTok: 0.1,
    cacheCreationPricePerMTok: 0.7,
    reasoningPricePerMTok: 2.2,
    enabled: true,
    createdAt: '2026-11-09T00:00:00.000Z',
    updatedAt: '2026-11-09T00:00:00.000Z',
  };

  test('loadRules populates rules and fallback from GET /api/pricing/rules', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      rules: [rule],
      fallback: { ...rule, id: 'cmp_fb', kind: 'fallback', pattern: '' },
    });

    await useModelPricingStore.getState().loadRules();

    expect(api.get).toHaveBeenCalledWith('/api/pricing/rules');
    const state = useModelPricingStore.getState();
    expect(state.rules).toHaveLength(1);
    expect(state.rules[0].pattern).toBe('glm-5.3-flash');
    expect(state.fallback?.id).toBe('cmp_fb');
    expect(state.error).toBeNull();
  });

  test('mutating actions call the right endpoints and reload', async () => {
    vi.mocked(api.post).mockResolvedValueOnce(rule);
    vi.mocked(api.get).mockResolvedValue({ rules: [rule], fallback: null });
    await useModelPricingStore.getState().createRule({
      kind: 'pattern',
      pattern: 'glm-5.3-flash',
      inputPricePerMTok: 0.6,
    });
    expect(api.post).toHaveBeenCalledWith('/api/pricing/rules', {
      kind: 'pattern',
      pattern: 'glm-5.3-flash',
      inputPricePerMTok: 0.6,
    });

    vi.mocked(api.patch).mockResolvedValueOnce(rule);
    await useModelPricingStore.getState().updateRule('cmp_test', {
      enabled: false,
    });
    expect(api.patch).toHaveBeenCalledWith('/api/pricing/rules/cmp_test', {
      enabled: false,
    });

    vi.mocked(api.delete).mockResolvedValueOnce({ success: true });
    await useModelPricingStore.getState().deleteRule('cmp_test');
    expect(api.delete).toHaveBeenCalledWith('/api/pricing/rules/cmp_test');
    expect(api.get).toHaveBeenCalledTimes(3);
  });

  test('row-level failures keep the list and surface through rethrow', async () => {
    useModelPricingStore.setState({ rules: [rule] });
    vi.mocked(api.delete).mockRejectedValueOnce(new Error('404'));

    await expect(
      useModelPricingStore.getState().deleteRule('cmp_missing'),
    ).rejects.toThrow('404');
    // 行级失败不得清空已加载列表
    expect(useModelPricingStore.getState().rules).toHaveLength(1);
  });

  test('preview posts the model name and returns the resolution source', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({
      source: 'custom',
      rule,
      pricing: { ...rule },
    });
    const result = await useModelPricingStore
      .getState()
      .preview('zhipu/GLM-5.3-FLASH:beta');
    expect(api.post).toHaveBeenCalledWith('/api/pricing/preview', {
      model: 'zhipu/GLM-5.3-FLASH:beta',
    });
    expect(result.source).toBe('custom');
    expect(result.rule?.pattern).toBe('glm-5.3-flash');
  });
});
