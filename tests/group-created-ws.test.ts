import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, test, vi } from 'vitest';

// ISSUE-16 A(a)：group_created 曾只剩前端消费端（生产者 broadcastGroupCreated
// 自建仓起零调用、后被当作死导出删除）。用户拍板补回生产者：不经 Web 的
// 工作区创建路径（IM /new、Agent register_group）经 registerGroup 统一出口
// 广播，只投递给工作区所有者。

const harness = vi.hoisted(() => ({
  clients: new Map<any, any>(),
  sessions: new Map<string, any>(),
}));

vi.mock('../src/web-context.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    wsClients: harness.clients,
    getCachedSessionWithUser: (sessionId: string) =>
      harness.sessions.get(sessionId),
    invalidateSessionCache: vi.fn(),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { broadcastGroupCreated } = await import('../src/web.js');

afterEach(() => {
  harness.clients.clear();
  harness.sessions.clear();
});

function addClient(sessionId: string, userId: string) {
  const client = {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    close: vi.fn(),
  };
  harness.sessions.set(sessionId, {
    id: sessionId,
    user_id: userId,
    username: userId,
    role: 'admin',
    status: 'active',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  harness.clients.set(client, { sessionId });
  return client;
}

describe('group_created WebSocket producer', () => {
  test('only the workspace owner receives group_created', () => {
    const owner = addClient('session-owner', 'gc-owner');
    const other = addClient('session-other', 'gc-other');

    broadcastGroupCreated('web:new-ws', 'flow-abc', '新工作区', 'gc-owner');

    expect(owner.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(owner.send.mock.calls[0][0])).toEqual({
      type: 'group_created',
      jid: 'web:new-ws',
      folder: 'flow-abc',
      name: '新工作区',
    });
    expect(other.send).not.toHaveBeenCalled();
  });

  test('ownerless registrations (startup default groups) are not broadcast', () => {
    const client = addClient('session-a', 'gc-a');

    broadcastGroupCreated('web:default', 'default', 'Default', undefined);
    broadcastGroupCreated('web:default', 'default', 'Default', null);

    expect(client.send).not.toHaveBeenCalled();
  });

  test('registerGroup (single exit for IM /new and agent register_group) emits the broadcast', () => {
    const source = fs
      .readFileSync(path.join(process.cwd(), 'src/index.ts'), 'utf8')
      .replace(/\r\n/g, '\n');
    const start = source.indexOf(
      'function registerGroup(jid: string, group: RegisteredGroup): void {',
    );
    expect(start).toBeGreaterThanOrEqual(0);
    const end = source.indexOf('\n}\n', start);
    const body = source.slice(start, end);
    expect(body).toContain(
      'broadcastGroupCreated(jid, group.folder, group.name, group.created_by)',
    );
    // 广播必须在持久化之后，前端收到后 loadGroups 才能读到新工作区。
    expect(body.indexOf('setRegisteredGroup(jid, group)')).toBeLessThan(
      body.indexOf('broadcastGroupCreated('),
    );

    // 两条非 Web 创建路径都经 registerGroup。
    const newCommandStart = source.indexOf('async function handleNewCommand(');
    expect(newCommandStart).toBeGreaterThanOrEqual(0);
    expect(
      source.slice(newCommandStart, source.indexOf('\n}\n', newCommandStart)),
    ).toContain('registerGroup(newJid, newGroup)');
    const ipc = fs.readFileSync(
      path.join(process.cwd(), 'src/ipc/skill-registry-ops.ts'),
      'utf8',
    );
    expect(ipc).toContain('registerGroup(data.jid, {');
  });
});
