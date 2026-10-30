import fs from 'fs';
import path from 'path';

import type { RegisteredGroup } from './types.js';

/**
 * Roots a send_file IPC request may read files from.
 * - `primary`: the workspace the runner actually operates in — a host
 *   workspace's custom cwd when one is configured, else
 *   `data/groups/<folder>`. Relative `filePath`s resolve against it,
 *   mirroring the runner's spawn cwd (container-runner.ts hostModeSetup).
 * - `workspace`: the canonical group folder under the groups dir. IM channel
 *   downloads (im-downloader.ts) always land there even when the runner cwd
 *   is a custom directory, so it stays an accepted root.
 */
export interface SendFileRoots {
  primary: string;
  workspace: string;
}

export type SendFilePathResolution =
  | { ok: true; path: string }
  | { ok: false; reason: 'outside_roots'; candidate: string };

/**
 * Resolve the allowed file-delivery roots for a group's send_file IPC,
 * mirroring container-runner's host workingDir resolution (customCwd must be
 * absolute; realpath best-effort; a missing or non-directory custom cwd falls
 * back instead of failing delivery). Container mode and host workspaces
 * without a custom cwd keep the legacy `data/groups/<folder>` semantics.
 */
export function resolveSendFileRoots(
  groupsDir: string,
  groupFolder: string,
  group?: Pick<RegisteredGroup, 'executionMode' | 'customCwd'> | null,
): SendFileRoots {
  const workspaceRoot = path.resolve(groupsDir, groupFolder);
  let primary = workspaceRoot;
  if (group?.executionMode === 'host' && group.customCwd) {
    const customCwd = group.customCwd;
    if (path.isAbsolute(customCwd)) {
      try {
        const real = fs.realpathSync(customCwd);
        if (fs.statSync(real).isDirectory()) {
          primary = path.resolve(real);
        }
      } catch {
        // Custom cwd vanished or is unreadable: stay on the legacy root.
      }
    }
  }
  return { primary, workspace: workspaceRoot };
}

/**
 * Turn an IPC `filePath` into a concrete candidate path inside one of the
 * allowed roots. Relative paths resolve against the primary root; absolute
 * paths are accepted only when they already resolve inside an allowed root
 * (joining an absolute path under the roots dir used to produce a
 * garbage-but-lexically-inside path that then failed as "not found"). The
 * caller still applies the symlink-escape check (isRealpathInside) on the
 * final candidate, including the downloads-fallback case.
 */
export function resolveSendFilePath(
  roots: SendFileRoots,
  filePath: string,
): SendFilePathResolution {
  const candidate = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(roots.primary, filePath);
  const allowedRoots = [roots.primary, roots.workspace].map(
    (root) => path.resolve(root) + path.sep,
  );
  if (!allowedRoots.some((root) => candidate.startsWith(root))) {
    return { ok: false, reason: 'outside_roots', candidate };
  }
  return { ok: true, path: candidate };
}
