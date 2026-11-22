import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const read = (file: string) =>
  fs.readFileSync(path.join(process.cwd(), file), 'utf8');

describe('Agent runtime context explainability', () => {
  test('records actual context audits host-side without publishing them to chat', () => {
    // ISSUE-10 拍板⑤：context_audit 事件通道整体下线，宿主在
    // container-runner 的容器与宿主机两路径构造审计后直记快照；Web 层
    // 不再接触审计对象。
    const containerRunner = read('src/container-runner.ts');
    const web = read('src/web.ts');
    const store = read('web/src/stores/chat.ts');

    expect(containerRunner).toContain('recordRunContextSnapshot({');
    expect(
      containerRunner.match(/recordRunContextSnapshot\(\{/g)?.length,
    ).toBeGreaterThanOrEqual(2);
    expect(web).not.toContain('recordRunContextSnapshot({');
    expect(store).not.toContain("if (event.eventType === 'context_audit')");
  });

  test('shows prompt provenance, real Skill usage, and total SDK budget per workspace', () => {
    const preview = read(
      'web/src/components/agents/EffectiveCapabilitiesPreview.tsx',
    );

    expect(preview).toContain('run_context: RunContextSnapshot | null');
    expect(preview).toContain('最近真实运行');
    expect(preview).toContain('总上下文');
    expect(preview).toContain('Prompt Plan');
    expect(preview).toContain('snapshot.skills.included');
    expect(preview).toContain('snapshot.skills.manifestHash');
    expect(preview).toContain('usage.mcpTools.length');
    expect(preview).toContain('来自旧智能体配置');
    expect(preview).toContain('snapshot.subagentContract');
  });
});
