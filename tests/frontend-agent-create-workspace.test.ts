import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const readAgentProfilesPage = () =>
  fs.readFileSync(
    path.join(process.cwd(), 'web/src/pages/AgentProfilesPage.tsx'),
    'utf8',
  );

describe('Agent creation workspace', () => {
  test('opens creation in the main workspace instead of a compact sidebar panel', () => {
    // ISSUE-12 波 5 单元 5.5：新建面板 section 已迁
    // web/src/components/agents/AgentCreatePanel.tsx（原文搬运），锚随体迁
    // ——面板内容断言改读组件文件，aside/main 结构断言仍读页面。
    const page = readAgentProfilesPage();
    const aside = page.slice(page.indexOf('<aside'), page.indexOf('</aside>'));
    const main = page.slice(page.indexOf('<main'));
    const createPanel = fs.readFileSync(
      path.join(
        process.cwd(),
        'web/src/components/agents/AgentCreatePanel.tsx',
      ),
      'utf8',
    );

    expect(aside).toContain('onClick={handleOpenCreatePanel}');
    expect(aside).not.toContain('new-agent-description');
    expect(aside).not.toContain('<Textarea');
    expect(main).toContain('{createPanelOpen && !draftMode ? (');
    expect(main).toContain('<AgentCreatePanel');
    expect(createPanel).toContain('id="create-agent-title"');
    expect(createPanel).toContain('id="new-agent-description"');
    expect(createPanel).toContain('AI 生成配置');
    expect(createPanel).toContain('空白创建');
  });

  test('keeps the large creation workspace labelled, responsive, and keyboard accessible', () => {
    // ISSUE-12 波 5 单元 5.5：同上，锚随体迁改读组件文件，断言文本不变。
    const createPanel = fs.readFileSync(
      path.join(
        process.cwd(),
        'web/src/components/agents/AgentCreatePanel.tsx',
      ),
      'utf8',
    );

    expect(createPanel).toContain('aria-labelledby="create-agent-title"');
    expect(createPanel).toContain('htmlFor="new-agent-description"');
    expect(createPanel).toContain(
      'aria-describedby="new-agent-description-help"',
    );
    expect(createPanel).toContain('min-h-[180px]');
    expect(createPanel).toContain('sm:flex-row');
    expect(createPanel).toContain('focus-visible:ring-2');
  });

  test('routes create links to the same main-workspace entry flow', () => {
    // ISSUE-12 波 5 单元 5.1：?create=1 路由效应已随
    // useUnsavedNavigationGuard hook 迁 web/src/hooks/useUnsavedNavigationGuard.ts
    // （原文搬运），锚随体迁、切片标记与断言文本不变。
    const page = fs.readFileSync(
      path.join(process.cwd(), 'web/src/hooks/useUnsavedNavigationGuard.ts'),
      'utf8',
    );
    const createRouteEffect = page.slice(
      page.indexOf("if (searchParams.get('create') !== '1') return;"),
      page.indexOf("if (searchParams.get('create') !== '1') return;") + 450,
    );

    expect(createRouteEffect).toContain('setDraftMode(false)');
    expect(createRouteEffect).toContain('setCreatePanelOpen(true)');
    expect(createRouteEffect).not.toContain('setCurrentPrompts');
  });

  test('protects typed creation intent without warning when the primary action consumes it', () => {
    const page = readAgentProfilesPage();
    const generateHandler = page.slice(
      page.indexOf('const handleGenerateDraft = async () => {'),
      page.indexOf('const handleBlankDraft = () => {'),
    );

    expect(page).toContain(
      'createPanelOpen && !draftMode && createDescription.trim().length > 0',
    );
    expect(page).toContain(
      'const hasUnsavedChanges = editorUnsavedChanges || createDirty',
    );
    expect(generateHandler).toContain('confirmDiscardEditorChanges()');
    expect(generateHandler).not.toContain('confirmDiscardUnsavedChanges()');
  });
});
