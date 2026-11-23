import { createHmac } from 'node:crypto';

import {
  buildWorkspaceMemoryMutationPayload,
  type WorkspaceMemoryMutationNamespace,
} from './workspace-memory-payload.js';

export type { WorkspaceMemoryMutationNamespace };

/**
 * Sign the exact mutation request that will be written to IPC. The secret is
 * retained only in the runner closure; the IPC payload contains this HMAC, not
 * the reusable bearer material.
 */
export function signWorkspaceMemoryMutation(
  secret: string,
  namespace: WorkspaceMemoryMutationNamespace,
  request: Record<string, unknown>,
): string {
  return createHmac('sha256', secret)
    .update(buildWorkspaceMemoryMutationPayload(namespace, request), 'utf8')
    .digest('base64url');
}
