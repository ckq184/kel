import { Hono } from 'hono';

import type { Variables } from '../web-context.js';
import { canAccessGroup } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthUser, RegisteredGroup } from '../types.js';
import { getAllRegisteredGroups, listApprovals } from '../db.js';
import { decideApproval } from '../approval-service.js';

/**
 * Tool approval API — list pending requests and record decisions.
 *
 * Visibility follows the workspace ACL (canAccessGroup). Deciding is
 * restricted to the workspace owner (created_by, resolved through the
 * registered group for the approval's folder).
 */

const approvals = new Hono<{ Variables: Variables }>();

approvals.use('*', authMiddleware);

interface GroupWithJid {
  group: RegisteredGroup;
  jid: string;
}

function resolveGroupByFolder(folder: string): GroupWithJid | undefined {
  for (const [jid, group] of Object.entries(getAllRegisteredGroups())) {
    if (group.folder === folder) return { group, jid };
  }
  return undefined;
}

function resolveOwnerUserId(folder: string): string | null {
  const resolved = resolveGroupByFolder(folder);
  if (resolved?.group.created_by) return resolved.group.created_by;
  // Legacy IM rows without created_by: the sibling home group carries the owner.
  for (const [, candidate] of Object.entries(getAllRegisteredGroups())) {
    if (
      candidate.folder === folder &&
      candidate.is_home &&
      candidate.created_by
    ) {
      return candidate.created_by;
    }
  }
  return null;
}

// List approvals across the workspaces the user can access.
approvals.get('/', (ctx) => {
  const user = ctx.get('user') as AuthUser | undefined;
  if (!user) return ctx.json({ error: 'unauthorized' }, 401);
  const accessible = listApprovals().filter((row) => {
    const resolved = resolveGroupByFolder(row.group_folder);
    return (
      resolved !== undefined &&
      canAccessGroup(
        { id: user.id, role: user.role },
        { ...resolved.group, jid: resolved.jid },
      )
    );
  });
  return ctx.json({ approvals: accessible });
});

// Decide a pending approval. Only the workspace owner may decide.
approvals.post('/:id/decision', async (ctx) => {
  const user = ctx.get('user') as AuthUser | undefined;
  if (!user) return ctx.json({ error: 'unauthorized' }, 401);
  const id = ctx.req.param('id');
  const body = await ctx.req.json<{ approved?: boolean }>().catch(() => null);
  if (!body || typeof body.approved !== 'boolean') {
    return ctx.json({ error: 'approved (boolean) is required' }, 400);
  }
  const row = listApprovals().find((entry) => entry.id === id);
  if (!row) return ctx.json({ error: 'not found' }, 404);

  const resolved = resolveGroupByFolder(row.group_folder);
  if (!resolved) return ctx.json({ error: 'workspace missing' }, 404);
  if (
    !canAccessGroup(
      { id: user.id, role: user.role },
      { ...resolved.group, jid: resolved.jid },
    )
  ) {
    return ctx.json({ error: 'not found' }, 404);
  }
  if (resolveOwnerUserId(row.group_folder) !== user.id) {
    return ctx.json(
      { error: 'only the workspace owner can decide approvals' },
      403,
    );
  }

  const ok = decideApproval(id, body.approved, user.id);
  if (!ok) return ctx.json({ error: 'already decided or missing' }, 409);
  return ctx.json({ ok: true, id, approved: body.approved });
});

export default approvals;
