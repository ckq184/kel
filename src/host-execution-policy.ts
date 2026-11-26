import type { User } from './types.js';

/**
 * Host execution is a live privilege, not a property inherited forever from
 * a workspace row. Callers must resolve the user from the database at the
 * point of execution and pass that current record here.
 */
export function canExecuteOnHost(
  owner: Pick<User, 'role' | 'status'> | null | undefined,
): boolean {
  return owner?.role === 'admin' && owner.status === 'active';
}

export const HOST_EXECUTION_FORBIDDEN_ERROR =
  'Host execution requires a currently active administrator owner';
