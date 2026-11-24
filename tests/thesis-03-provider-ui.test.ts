import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * THESIS-03 前端收口契约：设置页供应商编辑器与首次启动引导页只剩第三方表单。
 *
 * 背景：THESIS-02 已在接口层封口（type 只接受 third_party、OAuth 与订阅用量
 * 路由下线）。本包按方案 §5 T2 / §11.2 删除前端 official 分支、OAuth 流程、
 * 官方模型选择与订阅用量条，并把前端类型按 D-4 ① 收窄。
 *
 * 这些用例是源码契约：界面行为由 `make build` 与人工验收兜底。
 */

const root = path.resolve(import.meta.dirname, '..');
const read = (relative: string) =>
  fs.readFileSync(path.join(root, relative), 'utf8');
const exists = (relative: string) => fs.existsSync(path.join(root, relative));

describe('THESIS-03 ProviderEditor 只剩第三方', () => {
  const src = read('web/src/components/settings/ProviderEditor.tsx');

  test('不再有官方类型切换、官方认证页与 OAuth 流程', () => {
    expect(src).not.toMatch(/\bProviderType\b/);
    expect(src).not.toMatch(/\bOfficialAuthTab\b/);
    expect(src).not.toMatch(/\bproviderType\b/);
    expect(src).not.toMatch(/\bofficialTab\b/);
    expect(src).not.toMatch(/\boauthState\b/);
    expect(src).not.toMatch(/'official'/);
    expect(src).not.toMatch(/oauth\/start|oauth\/callback/);
    expect(src).not.toMatch(/官方模型选择|OAuth 登录|Setup Token/);
  });

  test('创建与编辑都只提交第三方供应商', () => {
    expect(src).toMatch(/type: 'third_party'/);
    expect(src).toMatch(/anthropicBaseUrl/);
    expect(src).toMatch(/anthropicAuthToken/);
    // 第三方表单的关键交互仍在（ISSUE-24 的请求头编辑与窗口声明）
    expect(src).toMatch(/自定义请求头/);
    expect(src).toMatch(/contextWindow/);
  });

  test('不再引用订阅用量条', () => {
    expect(src).not.toMatch(/UsageBars/);
  });
});

describe('THESIS-03 SetupProvidersPage 只剩第三方', () => {
  const src = read('web/src/pages/SetupProvidersPage.tsx');

  test('不再有模式切换、官方渠道与 OAuth 流程', () => {
    expect(src).not.toMatch(/\bProviderMode\b/);
    expect(src).not.toMatch(/\bproviderMode\b/);
    expect(src).not.toMatch(/\bOfficialTab\b/);
    expect(src).not.toMatch(/\bofficialTab\b/);
    expect(src).not.toMatch(/\bofficialToken\b/);
    expect(src).not.toMatch(/\boauthState\b/);
    expect(src).not.toMatch(/'official'/);
    expect(src).not.toMatch(/oauth\/start|oauth\/callback/);
    expect(src).not.toMatch(/官方渠道/);
  });

  test('第三方三必填仍在，引导可直接用第三方端点完成', () => {
    expect(src).toMatch(/type: 'third_party'/);
    expect(src).toMatch(/ANTHROPIC_BASE_URL/);
    expect(src).toMatch(/ANTHROPIC_AUTH_TOKEN/);
    expect(src).toMatch(/第三方渠道必须填写/);
  });
});

describe('THESIS-03 订阅用量条与官方凭据展示', () => {
  test('UsageBars 整文件删除', () => {
    expect(exists('web/src/components/settings/UsageBars.tsx')).toBe(false);
  });

  test('ProviderList 不再挂载用量条，也没有官方/第三方标签', () => {
    const src = read('web/src/components/settings/ProviderList.tsx');
    expect(src).not.toMatch(/UsageBars/);
    expect(src).not.toMatch(/'official'/);
    expect(src).not.toMatch(/官方/);
  });
});

describe('THESIS-03 前端类型按 D-4 ① 收窄', () => {
  test('供应商公共类型与模型配置选项只声明 third_party', () => {
    const providerTypes = read('web/src/components/settings/types.ts');
    const publicProvider = providerTypes.slice(
      providerTypes.indexOf('export interface UnifiedProviderPublic'),
      providerTypes.indexOf('export interface ProviderHealthStatus'),
    );
    expect(publicProvider).toMatch(/type: 'third_party';/);
    expect(publicProvider).not.toMatch(/'official'/);
    expect(publicProvider).not.toMatch(/ClaudeOAuth|ClaudeCodeOauth/);

    const globalTypes = read('web/src/types.ts');
    const modelConfig = globalTypes.slice(
      globalTypes.indexOf('export interface ModelConfigOption'),
      globalTypes.indexOf('export type AgentProfilePromptMode'),
    );
    expect(modelConfig).toMatch(/type: 'third_party';/);
    expect(modelConfig).not.toMatch(/'official'/);
  });

  test('OAuth 用量类型不再声明', () => {
    const providerTypes = read('web/src/components/settings/types.ts');
    expect(providerTypes).not.toMatch(
      /\b(CachedOAuthUsage|OAuthUsageResponse|OAuthUsageBucket)\b/,
    );
  });
});
