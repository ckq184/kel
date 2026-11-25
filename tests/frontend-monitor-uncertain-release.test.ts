import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../web/src/api/client', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import { api } from '../web/src/api/client';
import {
  useMonitorStore,
  type UncertainChannelOutboxItem,
} from '../web/src/stores/monitor';

const read = (file: string) =>
  fs.readFileSync(path.join(process.cwd(), file), 'utf8');

const uncertainItem = (
  overrides: Partial<UncertainChannelOutboxItem> = {},
): UncertainChannelOutboxItem => ({
  id: 'outbox-1',
  turnRunId: 'run-1',
  kind: 'text',
  ordinal: 1,
  revision: 7,
  provider: 'feishu',
  accountId: 'account-1',
  chatId: 'oc_target',
  attempt: 2,
  error: null,
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-20T00:05:00.000Z',
  ...overrides,
});

describe('monitor store uncertain channel outbox manual release', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMonitorStore.setState({ uncertainItems: [], uncertainError: null });
  });

  test('loads the uncertain outbox list through the documented endpoint', async () => {
    vi.mocked(api.get).mockResolvedValue({
      items: [uncertainItem()],
      total: 1,
    });

    await useMonitorStore.getState().loadUncertainOutbox();

    expect(api.get).toHaveBeenCalledWith(
      '/api/status/channel-outbox/uncertain',
    );
    expect(useMonitorStore.getState().uncertainItems).toHaveLength(1);
    expect(useMonitorStore.getState().uncertainItems[0]).toMatchObject({
      id: 'outbox-1',
      revision: 7,
      kind: 'text',
    });
    expect(useMonitorStore.getState().uncertainError).toBeNull();
  });

  test('load failures surface an error message instead of crashing polling', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('boom'));

    await useMonitorStore.getState().loadUncertainOutbox();

    expect(useMonitorStore.getState().uncertainError).toBe('boom');
  });

  test('resolves as delivered with CAS expectedRevision and providerMessageId, then re-reads the list', async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true });
    vi.mocked(api.get).mockResolvedValue({ items: [], total: 0 });

    await useMonitorStore
      .getState()
      .resolveUncertainOutbox('outbox-1', 'delivered', 7, 'om_123');

    expect(api.post).toHaveBeenCalledWith(
      '/api/status/channel-outbox/outbox-1/resolve',
      {
        resolution: 'delivered',
        expectedRevision: 7,
        providerMessageId: 'om_123',
      },
    );
    // 成功后必须重读列表（解决掉的行应立即从围栏列表消失）
    expect(api.get).toHaveBeenCalledWith(
      '/api/status/channel-outbox/uncertain',
    );
    expect(useMonitorStore.getState().uncertainItems).toEqual([]);
  });

  test('resolves as failed without providerMessageId in the payload', async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true });
    vi.mocked(api.get).mockResolvedValue({ items: [], total: 0 });

    await useMonitorStore
      .getState()
      .resolveUncertainOutbox('outbox-2', 'failed', 3);

    expect(api.post).toHaveBeenCalledWith(
      '/api/status/channel-outbox/outbox-2/resolve',
      { resolution: 'failed', expectedRevision: 3 },
    );
  });

  test('rejects delivered without providerMessageId before hitting the API', async () => {
    await expect(
      useMonitorStore
        .getState()
        .resolveUncertainOutbox('outbox-1', 'delivered', 7, '  '),
    ).rejects.toThrow(/渠道消息 ID/);

    expect(api.post).not.toHaveBeenCalled();
  });

  test('re-reads the list after a 409 revision conflict and propagates the error', async () => {
    vi.mocked(api.post).mockRejectedValue({
      status: 409,
      message: 'Outbox item changed since it was read',
    });
    vi.mocked(api.get).mockResolvedValue({ items: [], total: 0 });

    await expect(
      useMonitorStore
        .getState()
        .resolveUncertainOutbox('outbox-1', 'failed', 7),
    ).rejects.toMatchObject({ status: 409 });

    // revision 过期时不能盲目重试：先重读列表拿到最新 revision
    expect(api.get).toHaveBeenCalledWith(
      '/api/status/channel-outbox/uncertain',
    );
  });

  test('other resolve failures propagate without a silent re-read', async () => {
    vi.mocked(api.post).mockRejectedValue({
      status: 500,
      message: 'server error',
    });

    await expect(
      useMonitorStore
        .getState()
        .resolveUncertainOutbox('outbox-1', 'failed', 7),
    ).rejects.toMatchObject({ status: 500 });

    expect(api.get).not.toHaveBeenCalled();
  });
});

describe('monitor page uncertain release UI', () => {
  test('mounts the release card and polls it on the admin-only monitor page', () => {
    const page = read('web/src/pages/MonitorPage.tsx');

    expect(page).toContain('UncertainOutboxCard');
    // 与系统状态共用 10s 轮询；页面路由由 admin 角色守卫，不再按权限跳过
    expect(page).toMatch(/loadUncertainOutbox\(\);[\s\S]*10000/);
    expect(page).not.toContain('canManageSystem');
  });

  test('renders per-row release actions and hides the card when the list is empty', () => {
    const card = read('web/src/components/monitor/UncertainOutboxCard.tsx');

    expect(card).toContain('标已投递');
    expect(card).toContain('标失败');
    // 空列表整卡不渲染
    expect(card).toContain('uncertainItems.length === 0');
    // 行内展示身份与路由摘要，操作带 CAS revision 与 providerMessageId
    expect(card).toContain('item.revision');
    expect(card).toContain('providerMessageId');
    expect(card).toContain('item.updatedAt');
    expect(card).toContain('item.kind');
  });
});
