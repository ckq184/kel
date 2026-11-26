import type { RegisteredGroup } from './types.js';

/**
 * Check if a source group is authorized to send IPC messages to a target group.
 * - Home workspace can send to any group.
 * - Non-home groups can only send to groups sharing the same folder.
 * - IM channels bound (target_main_jid) to the source workspace are reachable
 *   from that workspace — without this, after agent-runner started rewriting
 *   ctx.chatJid to the IM source, send_file/send_image/send_message from
 *   non-home sub-workspaces got rejected.
 */
export function canSendCrossGroupMessage(
  isHome: boolean,
  sourceFolder: string,
  targetGroup: RegisteredGroup | undefined,
  lookupGroup: (jid: string) => RegisteredGroup | undefined,
): boolean {
  if (isHome) return true;
  if (targetGroup && targetGroup.folder === sourceFolder) return true;
  if (targetGroup?.target_main_jid) {
    const bound = lookupGroup(targetGroup.target_main_jid);
    if (bound?.folder === sourceFolder) return true;
  }
  return false;
}
