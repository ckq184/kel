import { create } from 'zustand';
import { api } from '../api/client';
import { extractErrorMessage } from '../utils/error';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

/** Mirror of the host `pending_approvals` row (GET /api/approvals). */
export interface PendingApproval {
  id: string;
  group_folder: string;
  chat_jid: string;
  tool_name: string;
  input_json: string | null;
  session_id: string | null;
  turn_id: string | null;
  status: ApprovalStatus;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

interface ApprovalsState {
  approvals: PendingApproval[];
  loading: boolean;
  error: string | null;
  decidingIds: Set<string>;
  loadApprovals: () => Promise<void>;
  decideApproval: (id: string, approved: boolean) => Promise<boolean>;
}

export const useApprovalsStore = create<ApprovalsState>((set, get) => ({
  approvals: [],
  loading: false,
  error: null,
  decidingIds: new Set(),

  loadApprovals: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{ approvals: PendingApproval[] }>(
        '/api/approvals',
      );
      set({ approvals: data.approvals, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: extractErrorMessage(err) });
    }
  },

  decideApproval: async (id, approved) => {
    set((s) => ({ decidingIds: new Set([...s.decidingIds, id]) }));
    try {
      await api.post(`/api/approvals/${id}/decision`, { approved });
      set({ error: null });
      await get().loadApprovals();
      return true;
    } catch (err) {
      set({ error: extractErrorMessage(err) });
      // Converge on races: a 409 means someone else (Web/IM card/command)
      // decided first — reload so the row reflects the final state.
      await get().loadApprovals();
      return false;
    } finally {
      set((s) => {
        const next = new Set(s.decidingIds);
        next.delete(id);
        return { decidingIds: next };
      });
    }
  },
}));
