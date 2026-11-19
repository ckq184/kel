// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { BindingTargetDialog } from '../web/src/components/settings/BindingTargetDialog';
import {
  resolveBindingTargetType,
  type BindingTarget,
} from '../web/src/components/settings/hooks/useImBindings';
import { buildBindHint } from '../src/im-command-utils';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const targets: BindingTarget[] = [
  {
    type: 'main',
    groupJid: 'web:ws-a',
    groupName: '工作区甲',
  },
  {
    type: 'session',
    groupJid: 'web:ws-a',
    groupName: '工作区甲',
    sessionId: 'sess-1',
    sessionName: '会话甲',
  },
  {
    type: 'main',
    groupJid: 'web:ws-b',
    groupName: '工作区乙',
  },
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderDialog(targetType: 'workspace' | 'session' | 'both') {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <BindingTargetDialog
        open
        imGroupName="测试聊天"
        targets={targets}
        targetsLoading={false}
        targetType={targetType}
        canUnbind={false}
        onSelect={vi.fn()}
        onRestoreDefault={vi.fn()}
        onClose={vi.fn()}
        selecting={null}
      />,
    );
  });
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('换绑目标对话框按 targetType 过滤渲染', () => {
  test('session 模式只渲染会话目标，不渲染主会话目标', async () => {
    await renderDialog('session');

    expect(document.body.textContent).toContain('会话甲');
    expect(document.body.textContent).not.toContain('绑定到此工作区');
  });

  test('workspace 模式只渲染主会话目标', async () => {
    await renderDialog('workspace');

    expect(document.body.textContent).toContain('绑定到此工作区');
    expect(document.body.textContent).not.toContain('会话甲');
  });

  test('both 模式全部渲染（回归）', async () => {
    await renderDialog('both');

    expect(document.body.textContent).toContain('会话甲');
    expect(document.body.textContent).toContain('绑定到此工作区');
  });
});

describe('resolveBindingTargetType', () => {
  test('群聊映射到 workspace，私聊/未知映射到 session', () => {
    expect(resolveBindingTargetType('group')).toBe('workspace');
    expect(resolveBindingTargetType('direct')).toBe('session');
    expect(resolveBindingTargetType('unknown')).toBe('session');
  });
});

describe('buildBindHint', () => {
  test('话题群提示绑定工作区，私聊/普通群提示绑定会话与恢复默认', () => {
    expect(buildBindHint(true)).toContain('/bind <工作区>');
    expect(buildBindHint(true)).not.toContain('<会话短ID>');

    expect(buildBindHint(false)).toContain('/bind <工作区>/<会话短ID>');
    expect(buildBindHint(false)).toContain('/unbind');
  });
});
