import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlaskConical, PlayCircle, RefreshCw } from 'lucide-react';

import { api } from '@/api/client';
import { wsManager } from '@/api/ws';
import { useAuthStore } from '@/stores/auth';
import { PageHeader } from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

/**
 * Native evaluation center (task AB).
 *
 * Tab 1「离线评测」— offline recall runs written by scripts/eval-auto-recall
 * into eval.db; every logged-in user can compare them.
 * Tab 2「真实对话」— observed real-conversation turns. Rows can carry
 * redacted conversation text, so the tab renders only for
 * manage_system_config (Monitor page precedent).
 */

interface EvalRunSummaryStat {
  n: number;
  recall: number;
  hitRate: number;
  mrr: number;
  precision: number;
}

interface EvalRun {
  id: string;
  name: string;
  kind: string;
  k: number;
  summary: {
    overall: EvalRunSummaryStat;
    perCategory: Record<string, EvalRunSummaryStat>;
  } | null;
  createdAt: string;
}

interface EvalRunItem {
  id: number;
  queryId: string;
  category: string;
  expected: string[];
  retrieved: string[];
  recall: number;
  hit: number;
  mrr: number;
  precision: number;
  latencyMs: number;
  note: string | null;
}

interface ComparisonRow {
  id: string | null;
  name: string | null;
  k: number | null;
  itemCount: number;
  recall: number | null;
  hitRate: number | null;
  mrr: number | null;
  precision: number | null;
}

interface ObservedTurn {
  turnId: string;
  workspaceJid: string | null;
  channel: string | null;
  interactionMode: string | null;
  recallInjected: number | null;
  recallHitCount: number | null;
  recallLatencyMs: number | null;
  inputText: string | null;
  outputText: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
  judgeUsed: number | null;
  judgeReasoning: string | null;
  judgeModel: string | null;
  createdAt: string;
}

function pct(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

function num(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return String(value);
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function MetricChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1 text-xs text-muted-foreground">
      <span>{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </span>
  );
}

// ── Tab 1: offline runs ─────────────────────────────────────────────────────

interface TriggerState {
  running: boolean;
  startedAt: number | null;
  startedBy: string | null;
  lines: string[];
  result: { success: boolean; error?: string } | null;
}

function EvalRunsPanel({ canTrigger }: { canTrigger: boolean }) {
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [detail, setDetail] = useState<{
    run: EvalRun;
    items: EvalRunItem[];
  } | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [comparison, setComparison] = useState<ComparisonRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Task AC web trigger (admin only): spawn the CLI harness from the page.
  const [trigger, setTrigger] = useState<TriggerState | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [triggerK, setTriggerK] = useState(5);
  const [triggerRunName, setTriggerRunName] = useState('');
  const [triggerReset, setTriggerReset] = useState(false);
  const [triggerSubmitting, setTriggerSubmitting] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<{ runs: EvalRun[] }>('/api/eval/runs');
      setRuns(data.runs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  // Trigger state: initial snapshot + live WS log lines (admin-only events,
  // docker-pull precedent). Completion refreshes the run list.
  useEffect(() => {
    if (!canTrigger) return;
    api
      .get<TriggerState>('/api/eval/runs/trigger/status')
      .then((data) => setTrigger(data))
      .catch(() => {});
    const unsubLog = wsManager.on('eval_run_log', (data: { line: string }) => {
      setTrigger((current) =>
        current
          ? { ...current, lines: [...current.lines.slice(-199), data.line] }
          : current,
      );
    });
    const unsubComplete = wsManager.on(
      'eval_run_complete',
      (data: { success: boolean; error?: string }) => {
        setTrigger((current) =>
          current ? { ...current, running: false, result: data } : current,
        );
        void loadRuns();
      },
    );
    return () => {
      unsubLog();
      unsubComplete();
    };
  }, [canTrigger, loadRuns]);

  const submitTrigger = useCallback(async () => {
    setTriggerSubmitting(true);
    setTriggerError(null);
    try {
      const runName =
        triggerRunName.trim() ||
        `web-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`;
      await api.post('/api/eval/runs/trigger', {
        k: triggerK,
        runName,
        reset: triggerReset,
      });
      setDialogOpen(false);
      setTrigger({
        running: true,
        startedAt: Date.now(),
        startedBy: null,
        lines: [],
        result: null,
      });
    } catch (err) {
      setTriggerError(err instanceof Error ? err.message : String(err));
    } finally {
      setTriggerSubmitting(false);
    }
  }, [triggerK, triggerRunName, triggerReset]);

  const openDetail = useCallback(async (id: string) => {
    setComparison(null);
    try {
      const data = await api.get<{ run: EvalRun; items: EvalRunItem[] }>(
        `/api/eval/runs/${encodeURIComponent(id)}`,
      );
      setDetail(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDetail(null);
    }
  }, []);

  const toggleCompare = useCallback((id: string, checked: boolean) => {
    setCompareIds((current) =>
      checked ? [...current, id] : current.filter((item) => item !== id),
    );
  }, []);

  const runComparison = useCallback(async () => {
    if (compareIds.length === 0) return;
    try {
      const data = await api.get<{ comparison: ComparisonRow[] }>(
        `/api/eval/comparison?ids=${compareIds.map(encodeURIComponent).join(',')}`,
      );
      setComparison(data.comparison);
      setDetail(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [compareIds]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold">评测 Runs</h3>
            <div className="flex items-center gap-2">
              {canTrigger && (
                <Button
                  size="sm"
                  onClick={() => {
                    setTriggerError(null);
                    setDialogOpen(true);
                  }}
                  disabled={trigger?.running === true}
                >
                  <PlayCircle className="w-4 h-4" />
                  运行评测
                </Button>
              )}
              {compareIds.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void runComparison()}
                >
                  对比（{compareIds.length}）
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => void loadRuns()}
                disabled={loading}
              >
                <RefreshCw
                  className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`}
                />
                刷新
              </Button>
            </div>
          </div>
          {canTrigger &&
            trigger &&
            (trigger.running || trigger.lines.length > 0) && (
              <div className="mb-3 rounded-lg border border-border p-3">
                <p className="mb-1 text-xs font-medium">
                  {trigger.running ? '评测运行中…' : '上次评测输出'}
                  {trigger.startedBy ? `（由 ${trigger.startedBy} 触发）` : ''}
                </p>
                <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 text-xs">
                  {trigger.lines.slice(-12).join('\n')}
                </pre>
              </div>
            )}
          {dialogOpen && (
            <div
              role="dialog"
              data-eval-run-dialog
              aria-label="运行评测"
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            >
              <div className="w-full max-w-md rounded-xl border border-border bg-card p-4 shadow-lg">
                <h4 className="mb-2 text-sm font-semibold">运行离线评测</h4>
                <p className="mb-3 rounded bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400">
                  将发起真实 embedder/LLM
                  请求并产生费用；评测在宿主以后台子进程执行， 完成后自动写入
                  eval.db 并刷新列表。
                </p>
                <label className="mb-2 block text-sm">
                  <span className="mb-1 block text-xs text-muted-foreground">
                    检索深度 k（1–10）
                  </span>
                  <select
                    data-eval-run-k
                    className="w-full rounded-md border border-border bg-background px-2 py-1.5"
                    value={triggerK}
                    onChange={(event) =>
                      setTriggerK(Number(event.target.value))
                    }
                  >
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((value) => (
                      <option key={value} value={value}>
                        k={value}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="mb-2 block text-sm">
                  <span className="mb-1 block text-xs text-muted-foreground">
                    Run 名称（字母/数字/连字符，留空自动生成）
                  </span>
                  <input
                    data-eval-run-name
                    className="w-full rounded-md border border-border bg-background px-2 py-1.5"
                    value={triggerRunName}
                    placeholder="如 k5-baseline"
                    onChange={(event) => setTriggerRunName(event.target.value)}
                  />
                </label>
                <label className="mb-3 flex items-center gap-2 text-sm">
                  <input
                    data-eval-run-reset
                    type="checkbox"
                    checked={triggerReset}
                    onChange={(event) => setTriggerReset(event.target.checked)}
                  />
                  重置评测侧车存储（--reset，强制重新播种）
                </label>
                {triggerError && (
                  <p className="mb-2 text-sm text-destructive" role="alert">
                    {triggerError}
                  </p>
                )}
                <div className="flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDialogOpen(false)}
                    disabled={triggerSubmitting}
                  >
                    取消
                  </Button>
                  <Button
                    size="sm"
                    disabled={triggerSubmitting}
                    onClick={() => void submitTrigger()}
                  >
                    {triggerSubmitting ? '启动中…' : '确认运行'}
                  </Button>
                </div>
              </div>
            </div>
          )}
          {error && (
            <p className="mb-2 text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          {runs.length === 0 && !loading && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              暂无评测记录——运行 npm run eval:auto-recall 后此处会出现结果
            </p>
          )}
          <div className="space-y-2">
            {runs.map((run) => (
              <div
                key={run.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border p-3"
              >
                <input
                  type="checkbox"
                  aria-label={`选择 ${run.id}`}
                  checked={compareIds.includes(run.id)}
                  onChange={(event) =>
                    toggleCompare(run.id, event.target.checked)
                  }
                />
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => void openDetail(run.id)}
                >
                  <span className="block truncate text-sm font-medium">
                    {run.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatTime(run.createdAt)} · k={run.k} ·{' '}
                    {run.summary?.overall.n ?? 0} 条查询
                  </span>
                </button>
                <div className="flex flex-wrap items-center gap-3">
                  <MetricChip
                    label="recall"
                    value={pct(run.summary?.overall.recall)}
                  />
                  <MetricChip
                    label="hit"
                    value={pct(run.summary?.overall.hitRate)}
                  />
                  <MetricChip
                    label="mrr"
                    value={
                      run.summary?.overall.mrr !== undefined &&
                      run.summary?.overall.mrr !== null
                        ? run.summary.overall.mrr.toFixed(2)
                        : '—'
                    }
                  />
                  <MetricChip
                    label="precision"
                    value={pct(run.summary?.overall.precision)}
                  />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {detail && (
        <Card>
          <CardContent className="p-4">
            <h3 className="mb-3 text-sm font-semibold">
              Run 详情 · {detail.run.name}
            </h3>
            <div className="space-y-2">
              {detail.items.map((item) => (
                <div
                  key={item.id}
                  className="rounded-lg border border-border p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-medium">{item.queryId}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                      {item.category}
                    </span>
                    <MetricChip label="recall" value={pct(item.recall)} />
                    <MetricChip label="mrr" value={item.mrr.toFixed(2)} />
                    <MetricChip label="precision" value={pct(item.precision)} />
                    <MetricChip label="latency" value={`${item.latencyMs}ms`} />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    expected: {item.expected.join(', ') || '—'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    retrieved: {item.retrieved.join(', ') || '—'}
                  </p>
                  {item.note && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      note: {item.note}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {comparison && (
        <Card>
          <CardContent className="p-4">
            <h3 className="mb-3 text-sm font-semibold">Runs 对比</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-4">Run</th>
                    <th className="py-2 pr-4">k</th>
                    <th className="py-2 pr-4">n</th>
                    <th className="py-2 pr-4">recall</th>
                    <th className="py-2 pr-4">hit</th>
                    <th className="py-2 pr-4">mrr</th>
                    <th className="py-2 pr-4">precision</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.map((row, index) => (
                    <tr
                      key={row.id ?? `missing-${index}`}
                      className="border-b border-border/50"
                    >
                      <td className="py-2 pr-4">
                        {row.name ?? '（未知 run）'}
                      </td>
                      <td className="py-2 pr-4">{row.k ?? '—'}</td>
                      <td className="py-2 pr-4">{row.itemCount}</td>
                      <td className="py-2 pr-4">{pct(row.recall)}</td>
                      <td className="py-2 pr-4">{pct(row.hitRate)}</td>
                      <td className="py-2 pr-4">
                        {row.mrr !== null ? row.mrr.toFixed(2) : '—'}
                      </td>
                      <td className="py-2 pr-4">{pct(row.precision)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Tab 2: observed turns (manage_system_config only) ──────────────────────

function ObservedTurnsPanel() {
  const [turns, setTurns] = useState<ObservedTurn[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspaceFilter, setWorkspaceFilter] = useState('');
  const [channelFilter, setChannelFilter] = useState('');
  const [onlyRecall, setOnlyRecall] = useState(false);

  const loadTurns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        limit: '50',
        offset: String(offset),
      });
      if (workspaceFilter.trim())
        params.set('workspace', workspaceFilter.trim());
      if (channelFilter.trim()) params.set('channel', channelFilter.trim());
      if (onlyRecall) params.set('recallInjected', 'true');
      const data = await api.get<{ items: ObservedTurn[]; total: number }>(
        `/api/eval/turns?${params.toString()}`,
      );
      setTurns(data.items);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [offset, workspaceFilter, channelFilter, onlyRecall]);

  useEffect(() => {
    void loadTurns();
  }, [loadTurns]);

  const judgeLabel = (turn: ObservedTurn): string => {
    if (turn.judgeUsed === null) return '未评';
    return turn.judgeUsed === 1 ? '已利用' : '未利用';
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input
              className="w-56 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              placeholder="工作区 JID 筛选"
              value={workspaceFilter}
              onChange={(event) => {
                setOffset(0);
                setWorkspaceFilter(event.target.value);
              }}
            />
            <input
              className="w-40 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              placeholder="渠道（web/feishu…）"
              value={channelFilter}
              onChange={(event) => {
                setOffset(0);
                setChannelFilter(event.target.value);
              }}
            />
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={onlyRecall}
                onChange={(event) => {
                  setOffset(0);
                  setOnlyRecall(event.target.checked);
                }}
              />
              仅看召回注入
            </label>
            <span className="text-xs text-muted-foreground">
              共 {total} 条（脱敏后内容）
            </span>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              onClick={() => void loadTurns()}
              disabled={loading}
            >
              <RefreshCw
                className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`}
              />
              刷新
            </Button>
          </div>
          {error && (
            <p className="mb-2 text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          {turns.length === 0 && !loading && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              暂无观测数据——写入 data/config/observability.json
              并重启后，真实对话会落库
            </p>
          )}
          <div className="space-y-1">
            {turns.map((turn) => (
              <div
                key={turn.turnId}
                className="rounded-lg border border-border"
              >
                <button
                  type="button"
                  className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 p-3 text-left text-sm"
                  aria-label={`展开 turn ${turn.turnId}`}
                  onClick={() =>
                    setExpanded((current) =>
                      current === turn.turnId ? null : turn.turnId,
                    )
                  }
                >
                  <span className="font-mono text-xs">{turn.turnId}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatTime(turn.createdAt)}
                  </span>
                  <span className="text-xs">{turn.workspaceJid ?? '—'}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                    {turn.channel ?? '—'}
                  </span>
                  <span className="text-xs">
                    召回:{turn.recallInjected === 1 ? '✓' : '—'}
                    {turn.recallInjected === 1 && turn.recallHitCount !== null
                      ? `×${turn.recallHitCount}`
                      : ''}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    judge:{judgeLabel(turn)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {num(turn.durationMs)}ms
                  </span>
                  <span className="text-xs text-muted-foreground">
                    tok {num(turn.inputTokens)}/{num(turn.outputTokens)}
                  </span>
                </button>
                {expanded === turn.turnId && (
                  <div className="space-y-2 border-t border-border p-3 text-xs">
                    {turn.inputText !== null || turn.outputText !== null ? (
                      <>
                        <div>
                          <p className="mb-1 font-medium">用户消息（脱敏后）</p>
                          <pre className="whitespace-pre-wrap break-words rounded bg-muted/50 p-2">
                            {turn.inputText ?? '—'}
                          </pre>
                        </div>
                        <div>
                          <p className="mb-1 font-medium">回答（脱敏后）</p>
                          <pre className="whitespace-pre-wrap break-words rounded bg-muted/50 p-2">
                            {turn.outputText ?? '—'}
                          </pre>
                        </div>
                      </>
                    ) : (
                      <p className="text-muted-foreground">
                        metadata 模式：内容未落库（指标齐全）
                      </p>
                    )}
                    {turn.judgeUsed !== null && (
                      <div>
                        <p className="mb-1 font-medium">
                          Judge（{turn.judgeModel ?? '—'}）：{judgeLabel(turn)}
                        </p>
                        <pre className="whitespace-pre-wrap break-words rounded bg-muted/50 p-2">
                          {turn.judgeReasoning ?? '—'}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          {total > 50 && (
            <div className="mt-3 flex items-center justify-between text-xs">
              <Button
                size="sm"
                variant="outline"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 50))}
              >
                上一页
              </Button>
              <span>
                {offset + 1}–{Math.min(offset + 50, total)} / {total}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={offset + 50 >= total}
                onClick={() => setOffset(offset + 50)}
              >
                下一页
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export function EvalPage() {
  const canManageSystem = useAuthStore((s) =>
    s.hasPermission('manage_system_config'),
  );
  const [tab, setTab] = useState<'runs' | 'turns'>('runs');

  const tabs = useMemo(
    () =>
      canManageSystem
        ? [
            { key: 'runs' as const, label: '离线评测' },
            { key: 'turns' as const, label: '真实对话' },
          ]
        : [{ key: 'runs' as const, label: '离线评测' }],
    [canManageSystem],
  );

  return (
    <div className="min-h-full bg-background p-4 lg:p-8">
      <div className="mx-auto max-w-7xl">
        <PageHeader
          title="评测"
          subtitle="离线召回评测与真实对话观测（原生 eval.db）"
          className="mb-6"
        />
        <div className="mb-4 flex gap-2" role="tablist">
          {tabs.map((entry) => (
            <Button
              key={entry.key}
              variant={tab === entry.key ? 'default' : 'outline'}
              size="sm"
              onClick={() => setTab(entry.key)}
              role="tab"
              aria-selected={tab === entry.key}
            >
              <FlaskConical className="w-4 h-4" />
              {entry.label}
            </Button>
          ))}
        </div>
        {tab === 'runs' ? (
          <EvalRunsPanel canTrigger={canManageSystem} />
        ) : (
          <ObservedTurnsPanel />
        )}
      </div>
    </div>
  );
}
