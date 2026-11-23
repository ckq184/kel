/**
 * Workspace Memory mutation signing payload shared by the host and the agent
 * runner.
 *
 * This is the single source of truth. Build step copies this file to:
 *   - src/workspace-memory-payload.ts
 *   - container/agent-runner/src/workspace-memory-payload.ts
 *
 * DO NOT edit the copies directly -- edit this file and run `make sync-types`.
 *
 * 签名一致性红线：runner（workspace-memory-auth）用它构造待签名内容并 HMAC，
 * 宿主（workspace-memory-capability）用它构造同一内容校验签名。两侧必须得出
 * 逐字节相同的字符串，否则所有 Workspace Memory 写入都会被拒绝（ISSUE-21 C1
 * 把原先两份同构实现收敛到这里）。
 */
import { normalizeForCanonicalJson } from './canonical-json.js';

export interface WorkspaceMemoryMutationNamespace {
  groupFolder: string;
  agentId?: string | null;
  taskRunId?: string | null;
}

/**
 * Build the exact string that is HMAC-signed for one mutation request. The
 * `mutationSignature` field itself is excluded so the signed request can be
 * verified as written to IPC.
 */
export function buildWorkspaceMemoryMutationPayload(
  namespace: WorkspaceMemoryMutationNamespace,
  request: Record<string, unknown>,
): string {
  const { mutationSignature: _signature, ...unsignedRequest } = request;
  return JSON.stringify(
    normalizeForCanonicalJson({
      namespace: {
        groupFolder: namespace.groupFolder,
        agentId: namespace.agentId ?? null,
        taskRunId: namespace.taskRunId ?? null,
      },
      request: unsignedRequest,
    }),
  );
}
