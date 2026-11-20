import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('agent capabilities deep link entry', () => {
  test('custom agent sidebar sections link to the profiles page capabilities anchor', () => {
    const sidebar = read('web/src/components/layout/UnifiedSidebar.tsx');
    const group = read('web/src/components/layout/AgentWorkspaceGroup.tsx');

    // 深链生产者接上：自定义智能体分组头通过 buildAgentCapabilitiesHref 生成
    // /agent-profiles?agent=<id>#agent-capabilities（契约见
    // tests/frontend-agent-product-contract.test.ts）。
    expect(sidebar).toContain('buildAgentCapabilitiesHref(section.id)');
    expect(sidebar).toContain('onManageCapabilities');

    // 分组组件渲染"管理能力"菜单项
    expect(group).toContain('onManageCapabilities');
    expect(group).toContain('管理能力');
  });

  test('the entry is only wired for custom agent partitions', () => {
    const sidebar = read('web/src/components/layout/UnifiedSidebar.tsx');

    // renderAgentSection 只服务 agentPartitions.custom；主智能体分区走
    // renderPrimaryAgentWorkspaces（能力在设置页"主智能体能力"管理，无此入口）。
    expect(sidebar).toContain('agentPartitions.custom.map(renderAgentSection)');

    const sectionStart = sidebar.indexOf('const renderAgentSection');
    const sectionEnd = sidebar.indexOf(
      'const renderPrimaryAgentWorkspaces',
      sectionStart,
    );
    const customRenderer = sidebar.slice(sectionStart, sectionEnd);
    expect(customRenderer).toContain('onManageCapabilities');

    const primaryStart = sidebar.indexOf('const renderPrimaryAgentWorkspaces');
    const primaryEnd = sidebar.indexOf('const panelWidth', primaryStart);
    const primaryRenderer = sidebar.slice(primaryStart, primaryEnd);
    expect(primaryRenderer).not.toContain('onManageCapabilities');
  });
});
