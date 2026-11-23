/**
 * ISSUE-21 C1：workspace-memory 能力的 HMAC 签名载荷只在
 * shared/workspace-memory-payload.ts 构造一次，经 make sync-types 同步到宿主与
 * runner；宿主校验与 runner 签名必须对同一请求得出同一签名。
 *
 * ISSUE-21 C3：shared/ 下每个文件都必须同时被同步脚本、同步检查脚本与
 * Makefile `_check-sync` 覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  issueWorkspaceMemoryWriteCapability,
  revokeWorkspaceMemoryWriteCapability,
  verifyAndConsumeWorkspaceMemoryMutation,
} from '../src/workspace-memory-capability.js';
import { signWorkspaceMemoryMutation } from '../container/agent-runner/src/workspace-memory-auth.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const read = (rel: string) =>
  fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');

describe('ISSUE-21 C1: single source for the workspace-memory signing payload', () => {
  test('host and runner copies are byte-identical to shared/', () => {
    const canonical = read('shared/workspace-memory-payload.ts');
    expect(read('src/workspace-memory-payload.ts')).toBe(canonical);
    expect(read('container/agent-runner/src/workspace-memory-payload.ts')).toBe(
      canonical,
    );
  });

  test('neither side builds the payload inline any more', () => {
    for (const consumer of [
      'src/workspace-memory-capability.ts',
      'container/agent-runner/src/workspace-memory-auth.ts',
    ]) {
      const source = read(consumer);
      expect(source, consumer).toMatch(
        /from '\.\/workspace-memory-payload\.js'/,
      );
      expect(source, consumer).not.toContain('normalizeForCanonicalJson');
    }
  });

  test('a runner signature verifies on the host once and only for the exact request', () => {
    const scope = { groupFolder: 'payload-folder', agentId: 'agent-1' };
    const { runnerInstanceId, signingSecret } =
      issueWorkspaceMemoryWriteCapability(scope, 'turn-1');
    try {
      const request = {
        type: 'memory_write',
        runnerInstanceId,
        inputTurnId: 'turn-1',
        body: { b: 2, a: [1, { d: 4, c: 3 }] },
      };
      const signature = signWorkspaceMemoryMutation(
        signingSecret,
        { groupFolder: scope.groupFolder, agentId: scope.agentId },
        request,
      );
      const signed = { ...request, mutationSignature: signature };

      expect(
        verifyAndConsumeWorkspaceMemoryMutation(
          scope,
          { ...signed, body: { b: 3, a: [1, { d: 4, c: 3 }] } },
          signature,
        ),
      ).toBe(false);
      expect(
        verifyAndConsumeWorkspaceMemoryMutation(scope, signed, signature),
      ).toBe(true);
      expect(
        verifyAndConsumeWorkspaceMemoryMutation(scope, signed, signature),
      ).toBe(false);
    } finally {
      revokeWorkspaceMemoryWriteCapability(scope, runnerInstanceId);
    }
  });
});

describe('ISSUE-21 C3: every shared/ file is synced and checked', () => {
  const sharedFiles = fs
    .readdirSync(path.join(repoRoot, 'shared'))
    .filter((name) => name.endsWith('.ts'));
  const makefile = read('Makefile');
  const checkSyncTarget = makefile.slice(
    makefile.indexOf('_check-sync:'),
    makefile.indexOf('_ensure-builtin-skills:'),
  );

  test.each(sharedFiles)(
    '%s is covered by sync, check and Makefile',
    (name) => {
      expect(read('scripts/sync-stream-event.sh')).toContain(`shared/${name}`);
      expect(read('scripts/check-stream-event-sync.sh')).toContain(
        `shared/${name}`,
      );
      const copy = name === 'stream-event.ts' ? 'stream-event.types.ts' : name;
      expect(checkSyncTarget).toContain(`src/${copy}`);
    },
  );
});
