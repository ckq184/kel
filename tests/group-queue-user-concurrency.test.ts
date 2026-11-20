import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('../src/container-runner.js', () => ({ killProcessTree: () => {} }));

// The queue-level system capacity check reads maxConcurrentContainers on every
// admission; keep it high so only the user-level limit under test can block.
const systemSettings = {
  maxConcurrentContainers: 100,
};

vi.mock('../src/runtime-config.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/runtime-config.js')>();
  return {
    ...actual,
    getSystemSettings: () => systemSettings,
  };
});

vi.mock('../src/db.js', () => ({ getTaskById: () => undefined }));

const { GroupQueue } = await import('../src/group-queue.js');
const { createUserContainerConcurrencyChecker } =
  await import('../src/runtime-config.js');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

type TestGroup = { created_by: string | null };
type TestUser = { id: string; role: string };

/** 生产 checker 工厂（src/runtime-config.ts createUserContainerConcurrencyChecker，
 * 与 src/index.ts main() 注入的是同一实现）+ 测试桩数据源。 */
function makeChecker(overrides?: {
  limit?: number | null;
  groups?: Record<string, TestGroup>;
  users?: Record<string, TestUser>;
  active?: Record<string, boolean>;
  taskRunners?: Record<string, number>;
  stats?: Pick<
    import('../src/runtime-config.js').UserContainerConcurrencyDeps,
    'hasDirectActiveRunner' | 'countActiveTaskRunners'
  >;
}) {
  const groups: Record<string, TestGroup> = overrides?.groups ?? {
    'web:ws-a': { created_by: 'user-a' },
    'web:ws-a2': { created_by: 'user-a' },
    'web:ws-b': { created_by: 'user-b' },
  };
  const users: Record<string, TestUser> = overrides?.users ?? {
    'user-a': { id: 'user-a', role: 'member' },
    'user-b': { id: 'user-b', role: 'member' },
  };
  const active = overrides?.active ?? {};
  const taskRunners = overrides?.taskRunners ?? {};
  let limit: number | null = overrides?.limit ?? null;
  const stats =
    overrides?.stats ??
    ({
      hasDirectActiveRunner: (jid: string) => active[jid] === true,
      countActiveTaskRunners: (baseJid: string) => taskRunners[baseJid] ?? 0,
    } as Pick<
      import('../src/runtime-config.js').UserContainerConcurrencyDeps,
      'hasDirectActiveRunner' | 'countActiveTaskRunners'
    >);
  const checker = createUserContainerConcurrencyChecker({
    getLimit: () => limit,
    getGroup: (baseJid: string) => groups[baseJid],
    getUserById: (userId: string) => users[userId],
    getOwnedJids: (ownerId: string) =>
      Object.entries(groups)
        .filter(([, group]) => group.created_by === ownerId)
        .map(([jid]) => jid),
    ...stats,
  });
  return {
    checker,
    setLimit: (value: number | null) => {
      limit = value;
    },
  };
}

const queues: InstanceType<typeof GroupQueue>[] = [];
const releases: Array<() => void> = [];

function createContainerQueue(): InstanceType<typeof GroupQueue> {
  const queue = new GroupQueue();
  queue.setHostModeChecker(() => false);
  queues.push(queue);
  return queue;
}

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await tick();
  await tick();
  queues.splice(0);
});

describe('createUserContainerConcurrencyChecker (production checker logic)', () => {
  test('limit=null disables the gate entirely', () => {
    const { checker } = makeChecker({
      limit: null,
      active: { 'web:ws-a': true, 'web:ws-b': true },
    });
    expect(checker('web:ws-a2')).toEqual({ allowed: true });
    expect(checker('web:ws-b')).toEqual({ allowed: true });
  });

  test('limit=1 blocks the owner beyond one active runner while other users are unaffected', () => {
    const { checker } = makeChecker({
      limit: 1,
      active: { 'web:ws-a': true },
    });
    // 同一用户 user-a 的第二个工作区（含 #task: 虚拟 JID）被拦。
    expect(checker('web:ws-a2')).toEqual({ allowed: false });
    expect(checker('web:ws-a2#task:t1')).toEqual({ allowed: false });
    // 其他用户不受影响。
    expect(checker('web:ws-b')).toEqual({ allowed: true });
  });

  test('counting mirrors the pre-billing-removal semantics: direct runners plus task virtual JIDs', () => {
    // user-a 无直接 runner，但 ws-a 有 1 个 task 虚拟 runner → 占 1 个名额。
    const { checker } = makeChecker({
      limit: 1,
      taskRunners: { 'web:ws-a': 1 },
    });
    expect(checker('web:ws-a2')).toEqual({ allowed: false });
    expect(checker('web:ws-b')).toEqual({ allowed: true });
  });

  test('admin owners bypass the limit', () => {
    const { checker } = makeChecker({
      limit: 1,
      groups: {
        'web:admin-ws': { created_by: 'admin-1' },
        'web:admin-ws2': { created_by: 'admin-1' },
      },
      users: { 'admin-1': { id: 'admin-1', role: 'admin' } },
      active: { 'web:admin-ws': true },
    });
    expect(checker('web:admin-ws2')).toEqual({ allowed: true });
  });

  test('unknown group owner fields and unknown users fall through as allowed', () => {
    const { checker } = makeChecker({
      limit: 1,
      groups: {
        'web:no-owner': { created_by: null },
        'web:ghost-owner': { created_by: 'ghost' },
      },
      users: {},
      active: {},
    });
    expect(checker('web:no-owner')).toEqual({ allowed: true });
    expect(checker('web:ghost-owner')).toEqual({ allowed: true });
  });

  test('the limit is read per call so settings hot-reload takes effect immediately', () => {
    const { checker, setLimit } = makeChecker({
      limit: 1,
      active: { 'web:ws-a': true },
    });
    expect(checker('web:ws-a2')).toEqual({ allowed: false });
    setLimit(null);
    expect(checker('web:ws-a2')).toEqual({ allowed: true });
    setLimit(2);
    expect(checker('web:ws-a2')).toEqual({ allowed: true });
  });
});

describe('GroupQueue container-mode admission with the production checker wired in', () => {
  test('a user at the limit has new sessions queued while another user starts freely', async () => {
    const queue = createContainerQueue();
    const { checker } = makeChecker({
      limit: 1,
      stats: {
        hasDirectActiveRunner: (jid) => queue.hasDirectActiveRunner(jid),
        countActiveTaskRunners: (baseJid) =>
          queue.countActiveTaskRunners(baseJid),
      },
    });
    queue.setUserConcurrentLimitChecker(checker);

    const first = deferred();
    const secondUser = deferred();
    releases.push(first.resolve, secondUser.resolve);
    const started: string[] = [];

    queue.enqueueTask('web:ws-a', 'ws-a-turn', async () => {
      started.push('ws-a');
      await first.promise;
    });
    // 同一 user-a 的另一工作区：用户级上限已满，必须排队。
    queue.enqueueTask('web:ws-a2', 'ws-a2-turn', async () => {
      started.push('ws-a2');
    });
    // 其他用户不受影响。
    queue.enqueueTask('web:ws-b', 'ws-b-turn', async () => {
      started.push('ws-b');
      await secondUser.promise;
    });

    await tick();
    expect(started.sort()).toEqual(['ws-a', 'ws-b']);
    expect(queue.getStatus().activeContainerCount).toBe(2);
    expect(queue.getStatus().waitingCount).toBe(1);

    first.resolve();
    await tick();
    await tick();
    expect(started.sort()).toEqual(['ws-a', 'ws-a2', 'ws-b']);
  });

  test('checker is transparent for the queue when the limit is unset', async () => {
    const queue = createContainerQueue();
    const { checker } = makeChecker({
      limit: null,
      stats: {
        hasDirectActiveRunner: (jid) => queue.hasDirectActiveRunner(jid),
        countActiveTaskRunners: (baseJid) =>
          queue.countActiveTaskRunners(baseJid),
      },
    });
    queue.setUserConcurrentLimitChecker(checker);

    const first = deferred();
    releases.push(first.resolve);
    const started: string[] = [];

    queue.enqueueTask('web:ws-a', 'a', async () => {
      started.push('ws-a');
      await first.promise;
    });
    queue.enqueueTask('web:ws-a2', 'a2', async () => {
      started.push('ws-a2');
    });

    await tick();
    expect(started.sort()).toEqual(['ws-a', 'ws-a2']);
    first.resolve();
    await tick();
  });
});
