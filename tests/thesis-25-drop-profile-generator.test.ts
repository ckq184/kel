import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');
const exists = (relativePath: string) =>
  fs.existsSync(path.join(root, relativePath));

describe('THESIS-25 Agent Profile generation/refinement removal', () => {
  test('backend routes and generator module are retired', () => {
    expect(exists('src/agent-profile-generator.ts')).toBe(false);

    const routes = read('src/routes/agent-profiles.ts');
    expect(routes).not.toContain('agent-profile-generator');
    expect(routes).not.toContain("'/generate'");
    expect(routes).not.toContain('refine-prompt');
    expect(routes).not.toContain('generateAgentProfileDraft');
    expect(routes).not.toContain('refineAgentProfilePrompt');
  });

  test('generation and refinement schemas are retired', () => {
    const schemas = read('src/schemas.ts');
    expect(schemas).not.toContain('AgentProfileGenerateSchema');
    expect(schemas).not.toContain('AgentProfileRefinePromptSchema');
    expect(schemas).not.toContain('AgentPromptSectionsSchema');
  });

  test('web prompt assistant, store actions and one-sentence creation entry are retired', () => {
    expect(exists('web/src/components/agents/AgentPromptAssistant.tsx')).toBe(
      false,
    );
    expect(exists('web/src/components/agents/AgentCreatePanel.tsx')).toBe(
      false,
    );

    const store = read('web/src/stores/agent-profiles.ts');
    expect(store).not.toContain('generateProfileDraft');
    expect(store).not.toContain('refineProfilePrompt');
    expect(store).not.toContain('AgentPromptChatMessage');
    expect(store).not.toContain('AgentPromptRefinement');
    expect(store).not.toContain('AgentProfileDraft');

    const page = read('web/src/pages/AgentProfilesPage.tsx');
    expect(page).not.toContain('AgentPromptAssistant');
    expect(page).not.toContain('AgentCreatePanel');
    expect(page).not.toContain('generateProfileDraft');
    expect(page).not.toContain('createDescription');

    const editor = read('web/src/components/agents/AgentPromptEditor.tsx');
    expect(editor).not.toContain('onOpenAssistant');
  });

  test('manual four-part prompts, version history and chat Agent Builder remain', () => {
    const page = read('web/src/pages/AgentProfilesPage.tsx');
    expect(page).toContain('<AgentPromptEditor');
    expect(page).toContain('<AgentPromptVersionHistory');

    const editor = read('web/src/components/agents/AgentPromptEditor.tsx');
    expect(editor).toContain('AGENT_PROMPT_SECTIONS');
    expect(editor).toContain('一键填入推荐模板');

    expect(exists('src/agent-builder.ts')).toBe(true);
  });

  test('API and model documentation no longer advertise the retired feature', () => {
    const api = read('docs/API.md');
    expect(api).not.toContain('/api/agent-profiles/generate');
    expect(api).not.toContain('/refine-prompt');

    const claude = read('CLAUDE.md');
    expect(claude).not.toContain('Agent Profile 生成');
  });
});
