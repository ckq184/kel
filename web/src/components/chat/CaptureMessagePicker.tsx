import { Checkbox } from '@/components/ui/checkbox';

/**
 * Message-level capture picker (task Y3).
 *
 * Newest-first checkbox list of one conversation's text messages with a
 * load-older pagination affordance. Pure presentational: selection state
 * and totals live in the parent dialog; the picker never talks to the API.
 */

/** One selectable message row ('' roles never reach here — filtered upstream). */
export interface PickerMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

interface CaptureMessagePickerProps {
  /** Chronological (oldest → newest); rendered newest-first. */
  messages: PickerMessage[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  disabled?: boolean;
}

export function CaptureMessagePicker({
  messages,
  selected,
  onToggle,
  hasMore,
  loadingMore,
  onLoadMore,
  disabled = false,
}: CaptureMessagePickerProps) {
  return (
    <div className="max-h-64 space-y-1 overflow-y-auto py-1">
      {[...messages].reverse().map((message) => (
        <label
          key={message.id}
          className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-2 text-sm transition-colors hover:bg-accent"
        >
          <Checkbox
            checked={selected.has(message.id)}
            onCheckedChange={() => onToggle(message.id)}
            disabled={disabled}
            className="mt-0.5"
          />
          <span className="shrink-0 text-xs text-muted-foreground">
            {message.role === 'user' ? '用户' : '助手'}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">
              {message.content.slice(0, 80)}
              {message.content.length > 80 ? '…' : ''}
            </span>
            <span className="block text-xs text-muted-foreground">
              {new Date(message.timestamp).toLocaleString()}
            </span>
          </span>
        </label>
      ))}
      {hasMore && (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={disabled || loadingMore}
          className="w-full rounded-md px-2 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
        >
          {loadingMore ? '加载中…' : '加载更早消息'}
        </button>
      )}
    </div>
  );
}
