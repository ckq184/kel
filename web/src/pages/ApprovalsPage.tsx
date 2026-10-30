import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useApprovalsStore, type PendingApproval } from '../stores/approvals';
import { wsManager } from '../api/ws';
import { showToast } from '../utils/toast';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { EmptyState } from '@/components/common/EmptyState';
import { PageHeader } from '@/components/common/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

type ApprovalView = 'pending' | 'all';

const STATUS_BADGE: Record<
  PendingApproval['status'],
  { label: string; variant: 'warning' | 'success' | 'error' | 'neutral' }
> = {
  pending: { label: '待审批', variant: 'warning' },
  approved: { label: '已批准', variant: 'success' },
  denied: { label: '已拒绝', variant: 'error' },
  expired: { label: '已过期', variant: 'neutral' },
};

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function inputSummary(approval: PendingApproval): string {
  if (!approval.input_json) return '（无参数）';
  try {
    const parsed = JSON.parse(approval.input_json);
    const text = JSON.stringify(parsed, null, 2);
    return text.length > 600 ? `${text.slice(0, 600)}…` : text;
  } catch {
    return approval.input_json.slice(0, 600);
  }
}

function ApprovalCard({
  approval,
  deciding,
  onDecide,
}: {
  approval: PendingApproval;
  deciding: boolean;
  onDecide: (approval: PendingApproval, approved: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const status = STATUS_BADGE[approval.status];
  const summary = useMemo(() => inputSummary(approval), [approval]);
  const shortId = approval.id.slice(0, 8);

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm font-medium text-foreground">
              {approval.tool_name}
            </span>
            <Badge variant={status.variant}>{status.label}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            工作区 {approval.group_folder} · 审批号 {shortId} ·{' '}
            {formatTime(approval.created_at)}
            {approval.decided_at
              ? ` · 决定于 ${formatTime(approval.decided_at)}${
                  approval.decided_by ? `（${approval.decided_by}）` : ''
                }`
              : ''}
          </p>
        </div>
        {approval.status === 'pending' && (
          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              disabled={deciding}
              onClick={() => onDecide(approval, true)}
            >
              <Check className="h-4 w-4" /> 批准
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={deciding}
              onClick={() => onDecide(approval, false)}
            >
              <X className="h-4 w-4" /> 拒绝
            </Button>
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        参数
      </button>
      {expanded && (
        <pre className="max-h-72 overflow-auto rounded-lg bg-muted p-3 text-xs font-mono whitespace-pre-wrap break-all">
          {summary}
        </pre>
      )}
    </div>
  );
}

export function ApprovalsPage() {
  const {
    approvals,
    loading,
    error,
    decidingIds,
    loadApprovals,
    decideApproval,
  } = useApprovalsStore();
  const [view, setView] = useState<ApprovalView>('pending');
  const [confirming, setConfirming] = useState<{
    approval: PendingApproval;
    approved: boolean;
  } | null>(null);

  useEffect(() => {
    loadApprovals();
  }, [loadApprovals]);

  // Real-time refresh: approval events arrive as top-level WS messages; the
  // 'connected' event covers the reconnect gap (missed events while offline).
  useEffect(() => {
    const unsubRequested = wsManager.on('approval_requested', () => {
      void loadApprovals();
    });
    const unsubDecided = wsManager.on('approval_decided', () => {
      void loadApprovals();
    });
    const unsubConnected = wsManager.on('connected', () => {
      void loadApprovals();
    });
    return () => {
      unsubRequested();
      unsubDecided();
      unsubConnected();
    };
  }, [loadApprovals]);

  // Polling fallback while anything is pending (WS may be down silently).
  const hasPending = approvals.some(
    (approval) => approval.status === 'pending',
  );
  useEffect(() => {
    if (!hasPending) return;
    const interval = setInterval(() => void loadApprovals(), 5000);
    return () => clearInterval(interval);
  }, [hasPending, loadApprovals]);

  const visible = useMemo(
    () =>
      view === 'pending'
        ? approvals.filter((approval) => approval.status === 'pending')
        : approvals,
    [approvals, view],
  );
  const pendingCount = approvals.filter(
    (approval) => approval.status === 'pending',
  ).length;

  const handleDecide = async (approval: PendingApproval, approved: boolean) => {
    const ok = await decideApproval(approval.id, approved);
    if (ok) {
      showToast(
        approved
          ? `已批准（工具 ${approval.tool_name}）`
          : `已拒绝（工具 ${approval.tool_name}）`,
      );
    } else {
      showToast('该审批已被处理或不可决定（可能是他人已决定或非工作区 owner）');
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="审批"
        subtitle="工具审批门禁挂起的请求：批准或拒绝后，挂起的 Agent 将在数秒内继续"
        actions={
          <>
            <Tabs
              value={view}
              onValueChange={(value) => setView(value as ApprovalView)}
            >
              <TabsList>
                <TabsTrigger value="pending">
                  待审批{pendingCount > 0 ? ` (${pendingCount})` : ''}
                </TabsTrigger>
                <TabsTrigger value="all">全部</TabsTrigger>
              </TabsList>
            </Tabs>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadApprovals()}
              disabled={loading}
            >
              <RefreshCw
                className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`}
              />
            </Button>
          </>
        }
      />

      {error && (
        <p className="text-sm text-error" role="alert">
          {error}
        </p>
      )}

      {visible.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title={view === 'pending' ? '没有待审批的请求' : '暂无审批记录'}
          description={
            view === 'pending'
              ? 'Agent 触发需要审批的工具时，请求会实时出现在这里'
              : '批准与拒绝的历史记录会保留在这里'
          }
        />
      ) : (
        <div className="space-y-3">
          {visible.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              deciding={decidingIds.has(approval.id)}
              onDecide={(target, approved) =>
                setConfirming({ approval: target, approved })
              }
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        onConfirm={async () => {
          if (!confirming) return;
          const target = confirming;
          setConfirming(null);
          await handleDecide(target.approval, target.approved);
        }}
        title={confirming?.approved ? '批准该工具调用？' : '拒绝该工具调用？'}
        message={
          confirming
            ? `工具 ${confirming.approval.tool_name}（审批号 ${confirming.approval.id.slice(0, 8)}）${
                confirming.approved
                  ? '将被放行，Agent 会继续执行。'
                  : '将被拒绝，Agent 会收到拒绝结果并另行处理。'
              }`
            : ''
        }
        confirmText={confirming?.approved ? '批准' : '拒绝'}
        confirmVariant={confirming?.approved ? 'primary' : 'danger'}
      />
    </div>
  );
}
