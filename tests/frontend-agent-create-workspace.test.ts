import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');
const exists = (relativePath: string) =>
  fs.existsSync(path.join(root, relativePath));

describe('Agent creation workspace', () => {
  test('opens a blank draft directly in the main workspace', () => {
    // THESIS-25：AI 一句话生成入口下线后，新建不再经过描述面板，
    // 侧栏与页面都直接进入空白草稿编辑。
    const page = read('web/src/pages/AgentProfilesPage.tsx');
    const aside = read('web/src/components/agents/AgentProfilesSidebar.tsx');
    const main = page.slice(page.indexOf('<main'));

    expect(aside).toContain('onClick={handleCreateNewAgent}');
    expect(aside).not.toContain('new-agent-description');
    expect(aside).not.toContain('<Textarea');
    expect(page).not.toContain('AgentCreatePanel');
    expect(exists('web/src/components/agents/AgentCreatePanel.tsx')).toBe(
      false,
    );
    expect(main).not.toContain('new-agent-description');
    expect(page).toContain('const handleCreateNewAgent = () => {');
    expect(page).toContain('if (!confirmDiscardEditorChanges()) return;');
    expect(page).toContain('beginBlankDraft();');
  });

  test('blank draft resets every editable part before entering draft mode', () => {
    const page = read('web/src/pages/AgentProfilesPage.tsx');
    const start = page.indexOf('const beginBlankDraft = () => {');
    const begin = page.slice(start, page.indexOf('useEffect(() => {', start));

    expect(begin).toContain('setDraftMode(true)');
    expect(begin).toContain('setSelectedId(null)');
    expect(begin).toContain("identity_prompt: ''");
    expect(begin).toContain("soul_prompt: ''");
    expect(begin).toContain("agents_prompt: ''");
    expect(begin).toContain("tools_prompt: ''");
    expect(begin).toContain('applyRuntimePolicyToForm(DEFAULT_RUNTIME_POLICY)');
    expect(begin).not.toContain('generateProfileDraft');
  });

  test('?create=1 routes to the same blank-draft entry flow', () => {
    // THESIS-25：?create=1 不再打开描述面板，而是请求空白草稿。
    const guard = read('web/src/hooks/useUnsavedNavigationGuard.ts');
    const createRouteEffect = guard.slice(
      guard.indexOf("if (searchParams.get('create') !== '1') return;"),
    );

    expect(createRouteEffect).toContain('requestBlankDraft()');
    expect(createRouteEffect).not.toContain('setCreatePanelOpen');
  });

  test('manual four-part prompt editing remains available', () => {
    const page = read('web/src/pages/AgentProfilesPage.tsx');

    expect(page).toContain('<AgentPromptEditor');
    expect(page).toContain('value={currentPrompts}');
    expect(page).toContain('onChange={setCurrentPrompts}');
    expect(exists('web/src/components/agents/AgentPromptEditor.tsx')).toBe(
      true,
    );
  });
});
