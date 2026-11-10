import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useAutoMemoryStore } from '../../stores/auto-memory';
import {
  CaptureMessagePicker,
  type PickerMessage,
} from './CaptureMessagePicker';

/**
 * Memory capture dialog (task Y2 session-merge + task Y3 message-pick).
 *
 * Two exclusive modes: 「按会话」 checkboxes the workspace's main
 * conversation plus every conversation sub-session, re-previewing the
 * merged cost (debounced 300ms — a pure DB read) under the shared
 * 400-message/60k-char server cap; 「按消息」 picks exact messages of the
 * CURRENT conversation with locally computed totals and a mirrored
 * refuse-not-trim budget guard. All API traffic goes through the
 * auto-memory store; the dialog never talks to the API endpoints directly.
 */

/** One selectable capture target. `id: ''` = main conversation. */
export interface CaptureTarget {
  id: string;
  name: string;
}

/** Current-conversation context for the message-pick mode (task Y3). */
export interface CaptureMessagePickerSource {
  /** '' = main conversation, else the agent sub-conversation id. */
  agentId: string;
  /** Chronological text messages currently loaded for that conversation. */
  messages: PickerMessage[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

interface CaptureMemoryDialogProps {
  open: boolean;
  groupJid: string;
  targets: CaptureTarget[];
  /** Preselected ids (usually the session the user is currently in). */
  defaultSelected: string[];
  messagePicker: CaptureMessagePickerSource;
  onClose: () => void;
}

/** Debounce for selection-driven re-previews (pure DB read, cheap). */
const PREVIEW_DEBOUNCE_MS = 300;

/** Mirror of the server's message-pick char budget (refuse, not trim). */
const MESSAGE_PICK_CHAR_BUDGET = 60_000;

// api client 抛的 ApiError 不是 Error 实例但带 message；把常见编码回执
// 映射成可行动的中文提示（验收：未配置 503 / 提炼超时均有明确文案）。
function captureErrorText(err: unknown, fallback: string): string {
  const message =
    err &&
    typeof err === 'object' &&
    typeof (err as { message?: unknown }).message === 'string'
      ? (err as { message: string }).message
      : '';
  if (message === 'not_configured')
    return '自动记忆未配置，请先在设置中完成端点配置';
  if (message === 'Request timeout' || message === 'unavailable')
    return '提炼超时或侧车不可用，可稍后重试';
  return message || fallback;
}

export function CaptureMemoryDialog({
  open,
  groupJid,
  targets,
  defaultSelected,
  messagePicker,
  onClose,
}: CaptureMemoryDialogProps) {
  const [mode, setMode] = useState<'sessions' | 'messages'>('sessions');
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(defaultSelected),
  );
  const [pickedIds, setPickedIds] = useState<Set<string>>(() => new Set());
  const [preview, setPreview] = useState<{
    messages: number;
    chars: number;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  // busy 覆盖 capture in-flight（提炼一次可能 10-60s，确认按钮防重入）。
  const [busy, setBusy] = useState(false);
  const previewCapture = useAutoMemoryStore((s) => s.previewCapture);
  const captureConversation = useAutoMemoryStore((s) => s.captureConversation);
  const captureMessagesAction = useAutoMemoryStore((s) => s.captureMessages);
  const requestSeq = useRef(0);

  // Re-seed the selection each time the dialog opens.
  useEffect(() => {
    if (open) {
      setSelected(new Set(defaultSelected));
      setPickedIds(new Set());
      setPreview(null);
    }
    // defaultSelected 是数组（每次渲染新引用），只在开关变化时重置。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Debounced merged-cost preview for the current session selection.
  useEffect(() => {
    if (!open || mode !== 'sessions') return;
    const agentIds = [...selected];
    const seq = ++requestSeq.current;
    setPreviewLoading(true);
    const timer = setTimeout(async () => {
      try {
        const result = await previewCapture(groupJid, agentIds);
        if (seq === requestSeq.current) setPreview(result);
      } catch (err) {
        if (seq === requestSeq.current) {
          setPreview(null);
          toast.error(captureErrorText(err, '获取提炼预览失败，请稍后重试'));
        }
      } finally {
        if (seq === requestSeq.current) setPreviewLoading(false);
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, selected, groupJid]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const togglePicked = (id: string) => {
    setPickedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Message-pick totals are computed locally — the message content is in
  // hand, and the server re-checks the same budget (refuse, not trim).
  const pickedMessages = messagePicker.messages.filter((m) =>
    pickedIds.has(m.id),
  );
  const pickedChars = pickedMessages.reduce(
    (sum, m) => sum + m.content.length,
    0,
  );
  const overBudget = pickedChars > MESSAGE_PICK_CHAR_BUDGET;

  const switchMode = (next: 'sessions' | 'messages') => {
    setMode(next);
    setPickedIds(new Set());
  };

  const handleConfirm = async () => {
    if (busy) return;
    if (mode === 'messages') {
      if (pickedIds.size === 0 || overBudget) return;
      setBusy(true);
      try {
        const receipt = await captureMessagesAction(
          groupJid,
          messagePicker.agentId,
          [...pickedIds],
        );
        const redacted =
          receipt.intercepted > 0
            ? `（${receipt.intercepted} 处疑似凭据已脱敏）`
            : '';
        toast.success(
          `提炼完成：捕获 ${receipt.captured} 条，新增 ${receipt.added} 条记忆${redacted}`,
        );
        onClose();
      } catch (err) {
        toast.error(captureErrorText(err, '提炼所选消息失败，请稍后重试'));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (selected.size === 0) return;
    setBusy(true);
    try {
      const receipt = await captureConversation(groupJid, [...selected]);
      const redacted =
        receipt.intercepted > 0
          ? `（${receipt.intercepted} 处疑似凭据已脱敏）`
          : '';
      toast.success(
        `提炼完成：捕获 ${receipt.captured} 条，新增 ${receipt.added} 条记忆${redacted}`,
      );
      onClose();
    } catch (err) {
      toast.error(captureErrorText(err, '提炼记忆失败，请稍后重试'));
    } finally {
      setBusy(false);
    }
  };

  const disabled =
    busy ||
    (mode === 'messages'
      ? pickedIds.size === 0 || overBudget
      : selected.size === 0);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>提炼记忆</DialogTitle>
          <DialogDescription>
            选择要送入自动记忆提炼的内容（仅文本消息，含跨会话历史）。
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 rounded-lg bg-muted p-1 text-xs">
          <button
            type="button"
            onClick={() => switchMode('sessions')}
            disabled={busy}
            className={
              mode === 'sessions'
                ? 'flex-1 rounded-md bg-background px-3 py-1.5 font-medium shadow-sm'
                : 'flex-1 rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground cursor-pointer'
            }
          >
            按会话
          </button>
          <button
            type="button"
            onClick={() => switchMode('messages')}
            disabled={busy}
            className={
              mode === 'messages'
                ? 'flex-1 rounded-md bg-background px-3 py-1.5 font-medium shadow-sm'
                : 'flex-1 rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground cursor-pointer'
            }
          >
            按消息
          </button>
        </div>

        {mode === 'sessions' ? (
          <>
            <div className="max-h-64 space-y-1 overflow-y-auto py-1">
              {targets.map((target) => (
                <label
                  key={target.id || '__main__'}
                  className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-sm transition-colors hover:bg-accent"
                >
                  <Checkbox
                    checked={selected.has(target.id)}
                    onCheckedChange={() => toggle(target.id)}
                    disabled={busy}
                  />
                  <span className="min-w-0 flex-1 truncate">{target.name}</span>
                </label>
              ))}
            </div>

            <p className="min-h-10 rounded-md bg-muted px-3 py-2 text-xs leading-5 text-muted-foreground">
              {previewLoading
                ? '正在统计所选会话…'
                : preview
                  ? `将把所选会话合并后最新 ${preview.messages} 条文本消息（约 ${preview.chars} 字）送入自动记忆提炼，产生一次模型调用。对话过长可能超时，可稍后重试。`
                  : '勾选会话后显示将提炼的条数与字数。'}
            </p>
          </>
        ) : (
          <>
            <CaptureMessagePicker
              messages={messagePicker.messages}
              selected={pickedIds}
              onToggle={togglePicked}
              hasMore={messagePicker.hasMore}
              loadingMore={messagePicker.loadingMore}
              onLoadMore={messagePicker.onLoadMore}
              disabled={busy}
            />

            <p className="min-h-10 rounded-md bg-muted px-3 py-2 text-xs leading-5 text-muted-foreground">
              {overBudget
                ? `所选消息合计 ${pickedChars.toLocaleString()} 字，超过 ${MESSAGE_PICK_CHAR_BUDGET.toLocaleString()} 字上限，请减少选择。`
                : `已选 ${pickedMessages.length} 条文本消息（约 ${pickedChars.toLocaleString()} 字），将精确送入自动记忆提炼，产生一次模型调用。`}
            </p>
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button onClick={handleConfirm} disabled={disabled}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            提炼
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
