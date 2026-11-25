import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  applyRegisteredGroupUpdate,
  detachThreadMapWorkspaceIfLast,
  markNativeContextWorkspace,
  resolveWorkspaceForBinding,
  resolveWorkspaceJid,
  type GroupBindingUpdateDeps,
} from '../src/channel-mount-service.js';
import { nowIso, requireDatabase } from '../src/store-helpers.js';
import type { RegisteredGroup } from '../src/types.js';

/**
 * ISSUE-11 B 部分契约测试：重复实现收敛（B1/B2/B6/B7/B8/B9/B10）。
 *
 * ① B1 折叠行为：markNativeContextWorkspace 统一取 config 折叠版（拍板 #6）
 *    —— 旧格式 `web:{folder}` 别名折叠到注册 jid 再写 native_thread 标记；
 *    未注册别名静默 no-op；缓存写带守卫（不凭空建缓存条目）；detach 语义锁。
 * ② B2 边缘行为：resolveWorkspaceJid 同 folder 多候选且第一个未注册时跳过
 *    未注册候选继续找（旧私有版在此场景返回 null，收敛后更健壮）；
 *    index.ts 私有副本删除、workspace-attribution 镜像 fold 改为委托。
 * ③ 单一实现源码 grep 契约：收敛后的各 helper 全仓只有一处定义；
 *    头像校验/MIME 映射/大小常量数值只在 avatar-upload.ts；
 *    计费 pattern 归一化只在 src/db.ts 保留单一实现（定价路由已随
 *    THESIS-08 删除）；
 *    OAuthUsageBucket 全仓 `export interface` 恰一次。
 * ④ 同步完整性：shared/ 规范源与两侧副本逐字节一致（fs 断言）。
 */

const root = path.resolve(import.meta.dirname, '..');
const read = (relative: string) =>
  fs.readFileSync(path.join(root, relative), 'utf8');

const SOURCE_DIRS = ['src', 'shared', 'container/agent-runner/src'];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  // ISSUE-15：清单字符串按 POSIX 分隔符归一——断言面书写仓库相对 posix 路径，
  // Windows 下 path.join 产出 '\' 会错判（打开文件仍用原生 path.join）。
  for (const entry of fs.readdirSync(path.join(root, dir), {
    withFileTypes: true,
  })) {
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(path.posix.join(dir, entry.name)));
    } else if (entry.name.endsWith('.ts')) {
      out.push(path.posix.join(dir, entry.name));
    }
  }
  return out;
}

const ALL_SOURCE_FILES = SOURCE_DIRS.flatMap(listSourceFiles);

function filesDefining(name: string, files: string[] = ALL_SOURCE_FILES) {
  const pattern = new RegExp(`function\\s+${name}\\s*(?:<[^>]*>)?\\s*\\(`);
  return files.filter((file) => pattern.test(read(file)));
}

function countOccurrences(pattern: RegExp, file: string): number {
  return (read(file).match(new RegExp(pattern.source, 'g')) ?? []).length;
}

// ───────────────────────────────────── ① B1 折叠行为（拍板 #6：取 config 折叠版）

function makeWorkspace(
  overrides: Partial<RegisteredGroup> = {},
): RegisteredGroup {
  return {
    name: 'Workspace',
    folder: 'ws-folder',
    added_at: '2026-11-20T00:00:00.000Z',
    ...overrides,
  };
}

interface BindingStoreFixture {
  groups: Record<string, RegisteredGroup>;
  inMemory: Record<string, RegisteredGroup>;
  writes: Array<[string, RegisteredGroup]>;
}

function makeBindingStore(
  groups: Record<string, RegisteredGroup>,
  inMemoryKeys: string[] = [],
): BindingStoreFixture {
  const inMemory: Record<string, RegisteredGroup> = {};
  for (const key of inMemoryKeys) {
    if (groups[key]) inMemory[key] = { ...groups[key] };
  }
  return { groups, inMemory, writes: [] };
}

function bindingDeps(fixture: BindingStoreFixture): GroupBindingUpdateDeps {
  return {
    getAllGroups: () => fixture.groups,
    getGroup: (jid: string) => fixture.groups[jid],
    getJidsByFolder: (folder: string) =>
      Object.entries(fixture.groups)
        .filter(([, group]) => group.folder === folder)
        .map(([jid]) => jid),
    setGroup: (jid: string, group: RegisteredGroup) => {
      fixture.writes.push([jid, group]);
      fixture.groups[jid] = group;
    },
    getInMemoryGroups: () => fixture.inMemory,
  };
}

describe('markNativeContextWorkspace folds legacy aliases (ISSUE-11 B1)', () => {
  test('folds a legacy web:{folder} alias onto the registered jid and writes native-thread markers', () => {
    const fixture = makeBindingStore(
      {
        'web:uuid-registered': makeWorkspace({
          conversation_source: 'manual',
          conversation_nav_mode: 'horizontal',
        }),
      },
      ['web:uuid-registered'],
    );

    markNativeContextWorkspace('web:ws-folder', bindingDeps(fixture));

    // 折叠目标：写入落在注册 jid 上，而不是旧格式别名上。
    expect(fixture.writes.map(([jid]) => jid)).toEqual(['web:uuid-registered']);
    expect(fixture.writes[0]![1]).toMatchObject({
      conversation_source: 'native_thread',
      conversation_nav_mode: 'vertical_threads',
    });
    expect(fixture.inMemory['web:uuid-registered']).toMatchObject({
      conversation_source: 'native_thread',
    });
  });

  test('silently no-ops when the alias matches no registered workspace', () => {
    const fixture = makeBindingStore({
      'web:other-folder': makeWorkspace({ folder: 'other-folder' }),
    });
    markNativeContextWorkspace('web:unknown-folder', bindingDeps(fixture));
    expect(fixture.writes).toEqual([]);
    expect(Object.keys(fixture.inMemory)).toEqual([]);
  });

  test('cache writes stay guarded: an untracked jid never gains a phantom entry', () => {
    const fixture = makeBindingStore({ 'web:uuid-1': makeWorkspace() });
    applyRegisteredGroupUpdate(
      'web:uuid-1',
      makeWorkspace({ conversation_source: 'native_thread' }),
      bindingDeps(fixture),
    );
    expect(fixture.writes.map(([jid]) => jid)).toEqual(['web:uuid-1']);
    expect(fixture.inMemory['web:uuid-1']).toBeUndefined();

    const tracked = makeBindingStore({ 'web:uuid-1': makeWorkspace() }, [
      'web:uuid-1',
    ]);
    applyRegisteredGroupUpdate(
      'web:uuid-1',
      makeWorkspace({ conversation_source: 'native_thread' }),
      bindingDeps(tracked),
    );
    expect(tracked.inMemory['web:uuid-1']).toMatchObject({
      conversation_source: 'native_thread',
    });
  });
});

describe('detachThreadMapWorkspaceIfLast (unified, ISSUE-11 B1)', () => {
  const previousThreadMap = {
    binding_mode: 'thread_map' as const,
    target_main_jid: 'web:ws-folder',
  };

  function topicSource(folder: string, target: string): RegisteredGroup {
    return makeWorkspace({
      name: `Topic ${folder}`,
      folder,
      target_main_jid: target,
      binding_mode: 'thread_map',
    });
  }

  test('keeps native navigation while another thread-map source remains', () => {
    const fixture = makeBindingStore({
      'web:ws-uuid': makeWorkspace({
        conversation_source: 'native_thread',
        conversation_nav_mode: 'vertical_threads',
      }),
      'feishu:topic-a': topicSource('source-a', 'web:ws-folder'),
      'feishu:topic-b': topicSource('source-b', 'web:ws-folder'),
    });

    detachThreadMapWorkspaceIfLast(
      previousThreadMap,
      'feishu:topic-a',
      undefined,
      undefined,
      bindingDeps(fixture),
    );
    expect(fixture.writes).toEqual([]);
  });

  test('resets navigation markers when the final thread-map source leaves', () => {
    const fixture = makeBindingStore({
      'web:ws-uuid': makeWorkspace({
        conversation_source: 'native_thread',
        conversation_nav_mode: 'vertical_threads',
      }),
      'feishu:topic-a': topicSource('source-a', 'web:ws-folder'),
    });

    detachThreadMapWorkspaceIfLast(
      previousThreadMap,
      'feishu:topic-a',
      undefined,
      undefined,
      bindingDeps(fixture),
    );
    expect(fixture.writes.map(([jid]) => jid)).toEqual(['web:ws-uuid']);
    expect(fixture.writes[0]![1]).toMatchObject({
      conversation_source: 'manual',
      conversation_nav_mode: 'horizontal',
    });
  });

  test('no-ops when the previous binding was not thread_map, or rebinding the same workspace', () => {
    const fixture = makeBindingStore({
      'web:ws-uuid': makeWorkspace({
        conversation_source: 'native_thread',
        conversation_nav_mode: 'vertical_threads',
      }),
      'feishu:topic-a': topicSource('source-a', 'web:ws-folder'),
    });

    // 非 thread_map 旧绑定：不摘除（统一签名内含守卫，取更健壮语义）。
    detachThreadMapWorkspaceIfLast(
      { binding_mode: 'single_context', target_main_jid: 'web:ws-folder' },
      'feishu:topic-a',
      undefined,
      undefined,
      bindingDeps(fixture),
    );
    expect(fixture.writes).toEqual([]);

    // 下一次绑定仍是同工作区的 thread_map：保留导航标记。
    detachThreadMapWorkspaceIfLast(
      previousThreadMap,
      'feishu:topic-a',
      'web:ws-uuid',
      'thread_map',
      bindingDeps(fixture),
    );
    expect(fixture.writes).toEqual([]);
  });
});

// ───────────────────────────────── ② B2 resolveWorkspaceJid 收敛与边缘行为

describe('resolveWorkspaceJid convergence edge behavior (ISSUE-11 B2)', () => {
  test('skips an unregistered folder candidate and keeps searching', () => {
    // 旧 src/index.ts 私有版在此场景返回 null（取第一个候选即停、终检失败）；
    // 收敛到 channel-mount-service 导出版后跳过未注册候选继续找——回归锁。
    const groups: Record<string, RegisteredGroup> = {
      'web:uuid-b': makeWorkspace({ folder: 'folder-x' }),
    };
    const resolved = resolveWorkspaceJid('web:folder-x', {
      getRegisteredGroup: (jid) => groups[jid],
      getJidsByFolder: () => ['web:ghost-unregistered', 'web:uuid-b'],
    });
    expect(resolved).toBe('web:uuid-b');
  });

  test('still returns null for a fully unregistered folder', () => {
    const resolved = resolveWorkspaceJid('web:folder-x', {
      getRegisteredGroup: () => undefined,
      getJidsByFolder: () => ['web:ghost-unregistered'],
    });
    expect(resolved).toBeNull();
  });

  test('index.ts drops its private copy and routes through the shared resolver', () => {
    const source = read('src/index.ts');
    expect(source).not.toMatch(/function\s+resolveWorkspaceJid\s*\(/);
    expect(source).toMatch(/resolveWorkspaceJid/);
    expect(source).toMatch(/'\.\/channel-mount-service\.js'/);
  });

  test('workspace-attribution delegates the legacy fold to the shared resolver', () => {
    const source = read('src/workspace-attribution.ts');
    expect(source).not.toMatch(/function\s+foldLegacyWorkspaceJid/);
    expect(source).toMatch(/resolveWorkspaceJid/);
    expect(source).toMatch(/'\.\/channel-mount-service\.js'/);
  });

  test('resolveWorkspaceForBinding folds aliases and stays a single implementation', () => {
    const groups: Record<string, RegisteredGroup> = {
      'web:uuid-1': makeWorkspace({ folder: 'legacy-folder' }),
    };
    expect(
      resolveWorkspaceForBinding('web:legacy-folder', {
        getAllGroups: () => groups,
        getGroup: (jid) => groups[jid],
      }),
    ).toEqual({ jid: 'web:uuid-1', group: groups['web:uuid-1'] });
    expect(
      resolveWorkspaceForBinding('web:missing', {
        getAllGroups: () => groups,
        getGroup: () => undefined,
      }),
    ).toBeNull();
  });
});

// ───────────────────────────────── ③ 单一实现源码 grep 契约

describe('each converged helper family has exactly one implementation', () => {
  test('route-level group-binding helpers live only in channel-mount-service', () => {
    for (const name of [
      'markNativeContextWorkspace',
      'resolveWorkspaceForBinding',
      'applyRegisteredGroupUpdate',
      'detachThreadMapWorkspaceIfLast',
      'getConversationKind',
      'fetchLiveChatInfo',
      'hasConsistentChannelAccount',
      'refreshAgentLastImJid',
    ]) {
      expect(filesDefining(name), name).toEqual([
        'src/channel-mount-service.ts',
      ]);
    }
    // The unguarded cache-write helper name is retired with the convergence:
    // the guarded applyRegisteredGroupUpdate replaces it repo-wide.
    expect(filesDefining('updateWorkspaceGroup')).toEqual([]);
  });

  test('resolveWorkspaceJid is defined once and consumed everywhere else', () => {
    expect(filesDefining('resolveWorkspaceJid')).toEqual([
      'src/channel-mount-service.ts',
    ]);
  });

  test('nowIso / requireDatabase live only in store-helpers', () => {
    expect(filesDefining('nowIso')).toEqual(['src/store-helpers.ts']);
    expect(filesDefining('requireDatabase')).toEqual(['src/store-helpers.ts']);
    for (const store of [
      'src/memory-store.ts',
      'src/owner-profile-store.ts',
      'src/channel-reliability-store.ts',
    ]) {
      expect(read(store), store).not.toMatch(/function\s+nowIso\s*\(/);
      expect(read(store), store).not.toMatch(/function\s+requireDatabase\s*\(/);
      expect(read(store), store).toContain("from './store-helpers.js'");
    }
    // channel-reliability-store 的 isoNow 是可注入时钟增强版，非逐字副本，保留。
    expect(read('src/channel-reliability-store.ts')).toMatch(
      /function\s+isoNow\s*\(/,
    );
  });

  test('requireDatabase preserves the three existing store error messages', () => {
    expect(() => requireDatabase(null, 'Workspace memory')).toThrow(
      'Workspace memory store is not initialized',
    );
    expect(() => requireDatabase(undefined, 'Owner Profile')).toThrow(
      'Owner Profile store is not initialized',
    );
    expect(() => requireDatabase(null, 'Channel reliability')).toThrow(
      'Channel reliability store is not initialized',
    );
    const db = { ok: 1 };
    expect(requireDatabase(db, 'Workspace memory')).toBe(db);
    // ISSUE-15：原写法连续调用两次 nowIso()，毫秒跨界即红（满载轮实测两翻）；
    // 取值一次再验证 round-trip 恒等，断言语义不变、竞态消除。
    const iso = nowIso();
    expect(new Date(iso).toISOString()).toBe(iso);
  });

  test('OAuthUsageBucket is declared exactly once repo-wide', () => {
    const files = ALL_SOURCE_FILES.filter((file) =>
      /export\s+interface\s+OAuthUsageBucket/.test(read(file)),
    );
    expect(files).toEqual(['src/runtime-config.ts']);
    expect(
      countOccurrences(
        /export\s+interface\s+OAuthUsageBucket/,
        'src/runtime-config.ts',
      ),
    ).toBe(1);
  });

  test('normalizePricingPattern is exported once', () => {
    expect(filesDefining('normalizePricingPattern')).toEqual(['src/db.ts']);
    expect(read('src/db.ts')).toMatch(
      /export\s+function\s+normalizePricingPattern/,
    );
  });

  test('avatar validation (size / MIME map / error text) lives only in the shared helper', () => {
    // 位于 src/ 根（同 http-upload-policy.ts 先例）：共享 helper 非 route 模块，
    // 放在 src/routes/ 会被 docs:check 要求入 API.md 路由索引。
    const shared = read('src/avatar-upload.ts');
    expect(shared).toContain('AVATAR_MAX_FILE_BYTES');
    expect(shared).toMatch(/['`]image\/jpeg['`]\s*:\s*['`]\.jpg['`]/);
    expect(shared).toContain("path.join(DATA_DIR, 'avatars')");
    for (const route of [
      'src/routes/config.ts',
      'src/routes/auth.ts',
      'src/routes/agent-profiles.ts',
    ]) {
      const source = read(route);
      expect(source, route).toContain('storeAvatarUpload');
      // 上传方向 MIME→扩展名映射不留在路由（auth 的下载方向 ext→MIME 表不在此断言面内）。
      expect(source, route).not.toMatch(
        /['`]image\/jpeg['`]\s*:\s*['`]\.jpg['`]/,
      );
      // 3MB 数值只在 http-upload-policy.ts，路由不得复制常量数值。
      expect(source, route).not.toMatch(/3\s*\*\s*1024\s*\*\s*1024/);
    }
    expect(read('src/http-upload-policy.ts')).toMatch(
      /export\s+const\s+AVATAR_MAX_FILE_BYTES\s*=\s*3\s*\*\s*1024\s*\*\s*1024/,
    );
  });

  test('cross-process canonical functions exist only as the synced trio', () => {
    expect(filesDefining('normalizeForCanonicalJson').sort()).toEqual([
      'container/agent-runner/src/canonical-json.ts',
      'shared/canonical-json.ts',
      'src/canonical-json.ts',
    ]);
    expect(filesDefining('stripOneMillionSuffix').sort()).toEqual([
      'container/agent-runner/src/model-suffix.ts',
      'shared/model-suffix.ts',
      'src/model-suffix.ts',
    ]);

    // 消费方改 import 本地副本，不再自带实现。ISSUE-21 C1：签名载荷收进
    // shared/workspace-memory-payload.ts，canonical-json 的消费方随之变为它的
    // 两份同步副本；宿主与 runner 改为导入载荷副本（见
    // tests/workspace-memory-payload.test.ts）。
    for (const consumer of [
      'src/workspace-memory-payload.ts',
      'container/agent-runner/src/workspace-memory-payload.ts',
    ]) {
      expect(read(consumer), consumer).not.toMatch(
        /function\s+normalizeForCanonicalJson/,
      );
      expect(read(consumer), consumer).toMatch(
        /from\s+'\.?\.?\/?canonical-json\.js'|from\s+'\.\.\/\.\.\/src\/canonical-json\.js'/,
      );
    }
    for (const consumer of [
      'src/runtime-config.ts',
      'container/agent-runner/src/context-window.ts',
    ]) {
      expect(read(consumer), consumer).not.toMatch(
        /function\s+stripOneMillionSuffix/,
      );
    }
    expect(read('src/runtime-config.ts')).toMatch(
      /from\s+'\.\/model-suffix\.js'/,
    );
    expect(read('container/agent-runner/src/context-window.ts')).toMatch(
      /from\s+'\.\/model-suffix\.js'/,
    );
  });

  test('both binding route files consume the shared implementations', () => {
    for (const route of ['src/routes/agents.ts', 'src/routes/config.ts']) {
      const source = read(route);
      expect(source, route).toMatch(/'\.\.\/channel-mount-service\.js'/);
      expect(source, route).toMatch(/\bmarkNativeContextWorkspace\b/);
      expect(source, route).not.toMatch(
        /function\s+markNativeContextWorkspace/,
      );
      expect(source, route).not.toMatch(/function\s+updateWorkspaceGroup/);
      expect(source, route).not.toMatch(
        /function\s+detachPreviousThreadMapIfLast/,
      );
      expect(source, route).not.toMatch(
        /function\s+detachThreadMapWorkspaceIfLast/,
      );
    }
  });
});

// ───────────────────────────────── ④ 同步完整性（fs 逐字节断言）

describe('synced copies are byte-identical to the shared canonical sources', () => {
  test('canonical-json and model-suffix copies match shared/ byte for byte', () => {
    const groups: Array<[string, string[]]> = [
      [
        'shared/canonical-json.ts',
        [
          'src/canonical-json.ts',
          'container/agent-runner/src/canonical-json.ts',
        ],
      ],
      [
        'shared/model-suffix.ts',
        ['src/model-suffix.ts', 'container/agent-runner/src/model-suffix.ts'],
      ],
    ];
    for (const [canonical, targets] of groups) {
      const source = fs.readFileSync(path.join(root, canonical));
      for (const target of targets) {
        const copy = fs.readFileSync(path.join(root, target));
        expect(copy.equals(source), target).toBe(true);
      }
    }
  });

  test('sync infrastructure covers the new shared files', () => {
    const syncScript = read('scripts/sync-stream-event.sh');
    expect(syncScript).toContain('shared/canonical-json.ts');
    expect(syncScript).toContain('shared/model-suffix.ts');
    const makefile = read('Makefile');
    for (const target of [
      'src/canonical-json.ts',
      'container/agent-runner/src/canonical-json.ts',
      'src/model-suffix.ts',
      'container/agent-runner/src/model-suffix.ts',
    ]) {
      expect(makefile, target).toContain(target);
    }
  });
});
