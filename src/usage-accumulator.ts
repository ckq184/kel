/**
 * THESIS-07：停记账之后，聊天气泡的耗时在宿主内存里按回复累加。
 *
 * 账本（usage_events/usage_records）曾负责把同一条可见回复收到的多次
 * `usage` 事件按 message_id 汇总；停记账后这个汇总改在本模块完成。
 * 按 D-C2 只保留 `durationMs` 与 `numTurns`，不再重建 token 明细。
 *
 * 约束：
 * - 纯内存、无 I/O；进程重启后正在累积的中间态会丢失（用户已确认接受）。
 * - `eventId` 用于去重 runner 重放；缺失时无法去重，仍按次累加。
 * - 条目数有上限，超出后按插入顺序淘汰最旧 key，避免长期运行无限增长。
 */

export interface UsageDurationTotals {
  durationMs: number;
  numTurns: number;
}

export interface UsageAccrualInput {
  eventId?: string;
  durationMs?: number;
  numTurns?: number;
}

export interface UsageAccumulatorOptions {
  /** 最多保留多少个回复的累加状态；默认 1024。 */
  maxEntries?: number;
  /** 每个回复最多记住多少个 eventId；默认 64。 */
  maxEventIdsPerEntry?: number;
}

export interface UsageAccumulator {
  /**
   * 把一次 usage 事件累加到 `key`（调用方用 chatJid + 消息 ID 构造）。
   * 返回该 key 当前的累计值；同一 eventId 重放时原样返回，不重复累加。
   */
  accrue(key: string, usage: UsageAccrualInput): UsageDurationTotals;
}

interface AccumulatorEntry {
  durationMs: number;
  numTurns: number;
  eventIds: Set<string>;
}

const DEFAULT_MAX_ENTRIES = 1024;
const DEFAULT_MAX_EVENT_IDS_PER_ENTRY = 64;

function positiveIntegerOr(
  value: number | undefined,
  fallback: number,
): number {
  return Number.isFinite(value) && (value as number) > 0
    ? Math.max(1, Math.floor(value as number))
    : fallback;
}

function nonNegative(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function snapshot(entry: AccumulatorEntry): UsageDurationTotals {
  return { durationMs: entry.durationMs, numTurns: entry.numTurns };
}

export function createUsageAccumulator(
  options: UsageAccumulatorOptions = {},
): UsageAccumulator {
  const maxEntries = positiveIntegerOr(options.maxEntries, DEFAULT_MAX_ENTRIES);
  const maxEventIdsPerEntry = positiveIntegerOr(
    options.maxEventIdsPerEntry,
    DEFAULT_MAX_EVENT_IDS_PER_ENTRY,
  );
  const entries = new Map<string, AccumulatorEntry>();

  function getOrCreate(key: string): AccumulatorEntry {
    const existing = entries.get(key);
    if (existing) return existing;
    if (entries.size >= maxEntries) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey !== undefined) entries.delete(oldestKey);
    }
    const created: AccumulatorEntry = {
      durationMs: 0,
      numTurns: 0,
      eventIds: new Set(),
    };
    entries.set(key, created);
    return created;
  }

  return {
    accrue(key, usage) {
      const entry = getOrCreate(key);
      const eventId =
        typeof usage.eventId === 'string' ? usage.eventId.trim() : '';
      if (eventId) {
        if (entry.eventIds.has(eventId)) return snapshot(entry);
        entry.eventIds.add(eventId);
        if (entry.eventIds.size > maxEventIdsPerEntry) {
          const oldestEventId = entry.eventIds.values().next().value;
          if (oldestEventId !== undefined) {
            entry.eventIds.delete(oldestEventId);
          }
        }
      }
      entry.durationMs += nonNegative(usage.durationMs);
      entry.numTurns += nonNegative(usage.numTurns);
      return snapshot(entry);
    },
  };
}
