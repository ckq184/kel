import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

const { resolveSendFileRoots, resolveSendFilePath } =
  await import('../src/send-file-path.js');

type SendFileRoots = import('../src/send-file-path.js').SendFileRoots;

const createdDirs: string[] = [];

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(label: string): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `send-file-${label}-`)),
  );
  createdDirs.push(dir);
  return dir;
}

function containerGroup(): { executionMode: 'container' } {
  return { executionMode: 'container' };
}

function hostGroup(customCwd: string): {
  executionMode: 'host';
  customCwd: string;
} {
  return { executionMode: 'host', customCwd };
}

describe('resolveSendFileRoots', () => {
  test('container mode and default host workspaces fall back to GROUPS_DIR/<folder>', () => {
    const groupsDir = makeTempDir('groups');
    const expectedRoot = path.resolve(groupsDir, 'flow-abc');

    expect(resolveSendFileRoots(groupsDir, 'flow-abc', undefined)).toEqual({
      primary: expectedRoot,
      workspace: expectedRoot,
    });
    expect(
      resolveSendFileRoots(groupsDir, 'flow-abc', containerGroup()),
    ).toEqual({
      primary: expectedRoot,
      workspace: expectedRoot,
    });
    // Host mode without a custom cwd still lives in the default folder.
    expect(
      resolveSendFileRoots(groupsDir, 'flow-abc', {
        executionMode: 'host',
      }),
    ).toEqual({ primary: expectedRoot, workspace: expectedRoot });
  });

  test('host workspace with a custom cwd resolves to that directory', () => {
    const groupsDir = makeTempDir('groups');
    const customCwd = makeTempDir('custom');
    const realCustomCwd = fs.realpathSync(customCwd);

    const roots = resolveSendFileRoots(
      groupsDir,
      'flow-abc',
      hostGroup(customCwd),
    );

    expect(roots.primary).toBe(path.resolve(realCustomCwd));
    // The canonical group folder stays an accepted root: IM channel
    // downloads always land there even when the runner cwd is custom.
    expect(roots.workspace).toBe(path.resolve(groupsDir, 'flow-abc'));
  });

  test('relative, missing, or host-inapplicable custom cwd falls back to the legacy root', () => {
    const groupsDir = makeTempDir('groups');
    const expectedRoot = path.resolve(groupsDir, 'flow-abc');

    expect(
      resolveSendFileRoots(groupsDir, 'flow-abc', hostGroup('relative/dir'))
        .primary,
    ).toBe(expectedRoot);
    expect(
      resolveSendFileRoots(
        groupsDir,
        'flow-abc',
        hostGroup(path.join(groupsDir, 'does-not-exist')),
      ).primary,
    ).toBe(expectedRoot);
    // customCwd is a host-mode concept; container groups always use the
    // canonical folder even if a stale customCwd value is present.
    expect(
      resolveSendFileRoots(groupsDir, 'flow-abc', {
        ...containerGroup(),
        customCwd: makeTempDir('ignored'),
      }).primary,
    ).toBe(expectedRoot);
  });
});

describe('resolveSendFilePath', () => {
  function rootsWithCustomCwd(): { roots: SendFileRoots; customCwd: string } {
    const groupsDir = makeTempDir('groups');
    const customCwd = makeTempDir('custom');
    return {
      roots: resolveSendFileRoots(groupsDir, 'flow-abc', hostGroup(customCwd)),
      customCwd,
    };
  }

  test('relative paths resolve against the primary (runner cwd) root', () => {
    const { roots, customCwd } = rootsWithCustomCwd();

    expect(resolveSendFilePath(roots, 'CLAUDE.md')).toEqual({
      ok: true,
      path: path.resolve(customCwd, 'CLAUDE.md'),
    });
    expect(resolveSendFilePath(roots, path.join('sub', 'report.pdf'))).toEqual({
      ok: true,
      path: path.resolve(customCwd, 'sub', 'report.pdf'),
    });
  });

  test('relative traversal escaping the primary root is rejected', () => {
    const { roots } = rootsWithCustomCwd();

    expect(resolveSendFilePath(roots, '../escape.txt')).toEqual({
      ok: false,
      reason: 'outside_roots',
      candidate: path.resolve(roots.primary, '../escape.txt'),
    });
    expect(
      resolveSendFilePath(roots, path.join('sub', '..', '..', 'escape.txt')).ok,
    ).toBe(false);
  });

  test('absolute paths inside an allowed root are accepted', () => {
    const { roots, customCwd } = rootsWithCustomCwd();
    const inside = path.join(customCwd, 'CLAUDE.md');

    expect(resolveSendFilePath(roots, inside)).toEqual({
      ok: true,
      path: path.resolve(inside),
    });
  });

  test('absolute paths outside every allowed root are rejected', () => {
    const { roots } = rootsWithCustomCwd();
    const outside = path.join(makeTempDir('elsewhere'), 'secret.txt');

    expect(resolveSendFilePath(roots, outside)).toEqual({
      ok: false,
      reason: 'outside_roots',
      candidate: path.resolve(outside),
    });
  });

  test('absolute paths inside the workspace (downloads) root are accepted', () => {
    const { roots } = rootsWithCustomCwd();
    const downloaded = path.join(
      roots.workspace,
      'downloads',
      'feishu',
      '2026-10-21',
      'report.pdf',
    );

    expect(resolveSendFilePath(roots, downloaded)).toEqual({
      ok: true,
      path: path.resolve(downloaded),
    });
  });

  test('an allowed root itself is not a deliverable file path', () => {
    const { roots, customCwd } = rootsWithCustomCwd();

    expect(resolveSendFilePath(roots, customCwd).ok).toBe(false);
  });
});
