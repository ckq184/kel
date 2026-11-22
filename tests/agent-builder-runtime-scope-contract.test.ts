import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe('Agent Builder runtime scope contract', () => {
  test('injects guidance and MCP tools by main-Agent identity instead of Home workspace', () => {
    const tools = read('container/agent-runner/src/mcp-tools.ts');

    const toolRegistration = section(
      tools,
      '// Agent Builder follows the effective top-level AgentProfile',
      '// Skill 安装/卸载仅限主容器',
    );
    expect(toolRegistration).toMatch(/if \(ctx\.agentBuilderEnabled\)/);
    expect(toolRegistration).not.toMatch(/if \(ctx\.isHome\)/);
  });

  test('derives capability from the effective profile for main and runtime sessions', () => {
    const host = read('src/index.ts');
    const web = read('src/web.ts');
    // ISSUE-12 波 4 单元 4.8：requireAgentBuilderActor 构建器已迁
    // src/ipc/memory-owner-ops.ts（原文搬运，闭包局部量转显式参数），
    // actorGate 切片改读新模块内构建器边界，断言语义不变。
    const memoryOwnerOps = read('src/ipc/memory-owner-ops.ts');

    // ISSUE-12 波 6 单元 6.0：A/B 两式 agentBuilderEnabled（原 A 内联×2 +
    // B 内联×1）随 runner 启动收敛进 runAgent 单一三元——B 式经
    // turnOptions.agentKind（B 调用点传 agent.kind）保留 conversation 守卫，
    // A 式缺省仅看 is_default；containerInput 以同名字段接线。锚随体迁、
    // 两式断言语义不变。
    expect(host).toMatch(
      /agentBuilderEnabled = turnOptions\?\.agentKind\s*\?\s*turnOptions\.agentKind === 'conversation' &&\s*resolvedAgentProfile\?\.is_default === true\s*:\s*resolvedAgentProfile\?\.is_default === true/,
    );
    expect(host).toMatch(/agentKind: agent\.kind,/);
    expect(host).toMatch(/\bagentBuilderEnabled,/);

    const actorGate = section(
      memoryOwnerOps,
      'export function requireAgentBuilderActorImpl',
      'export function requireOwnerProfileActorImpl',
    );
    expect(actorGate).toMatch(/getAgentBuilderRuntimeRejection/);
    expect(actorGate).toMatch(
      /agentBuilderTurnScope\(sourceGroup, ipcAgentId\)/,
    );
    expect(actorGate).not.toMatch(/!isHome/);

    expect(web).toMatch(
      /updateRoute\?\.\([\s\S]*?agent\.group_folder[\s\S]*?agentId,[\s\S]*?\);/,
    );
  });
});
