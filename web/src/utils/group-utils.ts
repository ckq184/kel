import type { GroupInfo } from '../types';

export type GroupEntry = GroupInfo & { jid: string };
/** Sort comparator: newest activity first. */
export function compareByLastActivity(a: GroupEntry, b: GroupEntry): number {
  return (
    new Date(b.lastMessageTime || b.added_at).getTime() -
    new Date(a.lastMessageTime || a.added_at).getTime()
  );
}
