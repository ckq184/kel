import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('internal context audit visibility contract', () => {
  test('retires the context_audit event channel entirely (ISSUE-10 拍板⑤)', () => {
    // ISSUE-07 曾要求 context_audit 事件永远不进用户可见面；ISSUE-10 起
    // 该事件类型与其传输通道整体下线，宿主改为在 container-runner 侧
    // 构造审计后直接 recordRunContextSnapshot。本契约守住三件事：
    // ① 事件词汇表不再包含 context_audit；② 宿主快照直记在
    // container-runner（容器 + 宿主机两路径）；③ 旧的事件消费分支零残留。
    const shared = read('shared/stream-event.ts');
    expect(shared).not.toMatch(/'context_audit'/);
    expect(shared).not.toMatch(/contextAudit\?:/);

    const containerRunner = read('src/container-runner.ts');
    expect(containerRunner).toMatch(
      /import \{[^}]*recordRunContextSnapshot[^}]*\} from '\.\/run-context-snapshot\.js';/,
    );
    expect(
      containerRunner.match(/recordRunContextSnapshot\(\{/g)?.length,
    ).toBeGreaterThanOrEqual(2);

    const feeder = read('src/stream-card-feeder.ts');
    expect(feeder).not.toMatch(/context_audit/);
    expect(feeder).not.toMatch(/contextAudit/);

    const web = read('src/web.ts');
    expect(web).not.toMatch(/context_audit/);
    expect(web).not.toMatch(/recordRunContextSnapshot/);
    expect(web).not.toMatch(/snap\.contextAudit/);

    const store = read('web/src/stores/chat.ts');
    expect(store).not.toMatch(/context_audit/);
    expect(store).not.toMatch(/StreamEvent\['contextAudit'\]/);

    const display = read('web/src/components/chat/StreamingDisplay.tsx');
    expect(display).not.toMatch(/AgentContextPanel/);
    expect(display).not.toMatch(/streaming\.contextAudit/);
    expect(display).not.toMatch(/label: 'Agent Context'/);
  });

  test('drops live and cached diagnostics before rendering chat UI', () => {
    const store = read('web/src/stores/chat.ts');
    const display = read('web/src/components/chat/StreamingDisplay.tsx');

    // Snapshot restore still scrubs non user-visible kinds before caching.
    expect(store).toMatch(/\.filter\(isUserVisibleTimelineEvent\)/);
    expect(store).toMatch(/\.filter\(isUserVisibleTraceEvent\)/);

    expect(display).toMatch(/status === 'requesting'\) return '正在处理…'/);
  });
});
