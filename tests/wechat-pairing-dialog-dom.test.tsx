// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

import { AccountConnectionDialog } from '../web/src/components/settings/ChannelAccountsManager';
import type { ChannelAccount } from '../web/src/stores/channel-accounts';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  generatePairing: vi.fn(),
  pairedLoad: vi.fn(),
  getOnboardingStatus: vi.fn(async () => ({
    onboarding: {
      auth_mode: 'qr_session' as const,
      auth_status: 'authorized' as const,
      transport_status: 'connected' as const,
    },
  })),
}));

vi.mock('../web/src/stores/channel-accounts', () => {
  const state = {
    accounts: [],
    loading: false,
    error: null,
    actionId: null,
    loadAccounts: vi.fn(),
    testAccount: vi.fn(),
    toggleAccount: vi.fn(),
    deleteAccount: vi.fn(),
    updateAccount: vi.fn(),
    logoutAccount: vi.fn(),
    disconnectAccount: vi.fn(),
    beginOnboarding: vi.fn(),
    getOnboardingStatus: mocks.getOnboardingStatus,
    verifyOnboardingCode: vi.fn(),
  };
  return {
    // Selector form is used by AccountConnectionDialog; selector-less
    // destructuring is used by QrOnboardingPanel — both must keep working.
    useChannelAccountsStore: (selector?: (state: unknown) => unknown) =>
      selector ? selector(state) : state,
  };
});

vi.mock('../web/src/components/settings/hooks/usePairingCode', () => ({
  usePairingCode: () => ({
    code: null,
    countdown: 0,
    generating: false,
    copied: false,
    generate: mocks.generatePairing,
    copyCommand: vi.fn(),
  }),
}));

vi.mock('../web/src/components/settings/hooks/usePairedChats', () => ({
  usePairedChats: () => ({
    chats: [],
    loading: false,
    error: null,
    removingJid: null,
    load: mocks.pairedLoad,
    remove: vi.fn(),
    rename: vi.fn(),
  }),
}));

const baseAccount = {
  owner_user_id: 'user-1',
  enabled: true,
  is_default: false,
  default_workspace_jid: 'web:main',
  last_error: null,
  connected_at: '2026-11-19T01:18:24.149Z',
  created_at: '2026-11-18T09:24:48.877Z',
  updated_at: '2026-11-19T01:18:24.149Z',
};

const wechatAuthorized: ChannelAccount = {
  ...baseAccount,
  id: 'wx-account',
  provider: 'wechat',
  name: 'wxBOT',
  status: 'connected',
  auth_mode: 'qr_session',
  auth_status: 'authorized',
  transport_status: 'connected',
  has_credentials: true,
};

const wechatUnauthorized: ChannelAccount = {
  ...wechatAuthorized,
  auth_status: 'draft',
  has_credentials: false,
  status: 'disconnected',
  transport_status: 'disconnected',
};

const qqAuthorized: ChannelAccount = {
  ...baseAccount,
  id: 'qq-account',
  provider: 'qq',
  name: 'QQBOT',
  status: 'connected',
  auth_mode: 'credentials',
  auth_status: 'authorized',
  transport_status: 'connected',
  has_credentials: true,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderDialog(account: ChannelAccount): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const router = createMemoryRouter([
    {
      path: '/',
      element: (
        <AccountConnectionDialog
          account={account}
          autoStart={false}
          onClose={vi.fn()}
        />
      ),
    },
  ]);
  await act(async () => {
    root?.render(<RouterProvider router={router} />);
  });
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe('渠道账号连接弹窗的聊天配对区渲染', () => {
  test('已授权的微信（qr_session）账号弹窗包含聊天配对与生成配对码', async () => {
    await renderDialog(wechatAuthorized);

    // Radix Dialog 通过 portal 渲染到 document.body，不在 container 内。
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('聊天配对');
    });
    expect(document.body.textContent).toContain('生成配对码');
    // 配对区文案应指向微信渠道名。
    expect(document.body.textContent).toContain('微信');
  });

  test('已授权的 QQ（credentials）账号弹窗仍包含聊天配对区（回归）', async () => {
    await renderDialog(qqAuthorized);

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('聊天配对');
    });
    expect(document.body.textContent).toContain('生成配对码');
  });

  test('未扫码授权的微信账号不渲染配对区', async () => {
    await renderDialog(wechatUnauthorized);

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('扫码与连接状态');
    });
    expect(document.body.textContent).not.toContain('聊天配对');
  });
});
