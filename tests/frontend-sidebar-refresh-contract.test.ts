import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('sidebar group_created refresh contract', () => {
  test('group_created refreshes the chat store that the sidebar actually reads', () => {
    const layout = read('web/src/components/layout/AppLayout.tsx');
    const sidebar = read('web/src/components/layout/UnifiedSidebar.tsx');

    // 侧栏工作区列表的数据源是 chat store（UnifiedSidebar 读 s.groups），
    // group_created 的刷新必须落在同一 store 上，否则新建工作区不出现在侧栏。
    expect(sidebar).toContain('const groups = useChatStore((s) => s.groups)');

    const handlerStart = layout.indexOf("wsManager.on('group_created'");
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    const handler = layout.slice(
      handlerStart,
      layout.indexOf('});', handlerStart) + 3,
    );
    expect(handler).toContain('useChatStore.getState().loadGroups()');
    expect(handler).not.toContain('useGroupsStore.getState().loadGroups()');
    // 任务列表刷新保留（workspace_folder 可能刚被填充）
    expect(handler).toContain('loadTasks()');
  });

  test('parallel groups store is no longer reloaded on group_created anywhere in the layout', () => {
    const layout = read('web/src/components/layout/AppLayout.tsx');
    // runner_state 等 handler 仍用 setRunnerState，但任何地方都不再整表刷新 groups store。
    expect(layout).not.toContain('useGroupsStore.getState().loadGroups()');
  });
});
