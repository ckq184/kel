import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './config.js';
import type {
  WorkflowAgentSnapshot,
  WorkflowPhaseSnapshot,
  WorkflowRunSnapshot,
} from './stream-event.types.js';

type MessageLike = {
  id: string;
  timestamp: string;
  session_id?: string | null;
  is_from_me?: boolean | number;
  workflow_runs?: WorkflowRunSnapshot[];
};

const cache = new Map<
  string,
  { signature: string; runs: WorkflowRunSnapshot[] }
>();

function finite(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeAgentState(value: unknown): WorkflowAgentSnapshot['state'] {
  switch (value) {
    case 'queued':
    case 'running':
    case 'done':
    case 'failed':
    case 'stopped':
      return value;
    case 'completed':
      return 'done';
    default:
      return 'unknown';
  }
}

function normalizeRunStatus(value: unknown): WorkflowRunSnapshot['status'] {
  switch (value) {
    case 'running':
    case 'completed':
    case 'failed':
    case 'stopped':
      return value;
    default:
      return 'unknown';
  }
}

/** Normalize both workflows/wf_*.json and task output JSON shapes. */
export function normalizeWorkflowRun(
  raw: Record<string, unknown>,
  fallbackTaskId = 'workflow',
): WorkflowRunSnapshot | null {
  const progress = Array.isArray(raw.workflowProgress)
    ? (raw.workflowProgress as Array<Record<string, unknown>>)
    : [];
  const declaredPhases = Array.isArray(raw.phases)
    ? (raw.phases as Array<Record<string, unknown>>)
    : [];
  const phasesByIndex = new Map<number, WorkflowPhaseSnapshot>();
  declaredPhases.forEach((phase, offset) => {
    const title = text(phase.title);
    if (!title) return;
    const index = finite(phase.index) ?? offset + 1;
    phasesByIndex.set(index, { index, title, detail: text(phase.detail) });
  });
  for (const item of progress) {
    if (item.type !== 'workflow_phase') continue;
    const title = text(item.title);
    if (!title) continue;
    const index = finite(item.index) ?? phasesByIndex.size + 1;
    const previous = phasesByIndex.get(index);
    phasesByIndex.set(index, {
      index,
      title,
      detail: text(item.detail) ?? previous?.detail,
    });
  }

  const agents: WorkflowAgentSnapshot[] = progress
    .filter((item) => item.type === 'workflow_agent')
    .map((item, offset) => ({
      index: finite(item.index) ?? offset + 1,
      label: text(item.label) ?? `Agent ${offset + 1}`,
      phaseIndex: finite(item.phaseIndex),
      phaseTitle: text(item.phaseTitle),
      agentId: text(item.agentId),
      model: text(item.model),
      fallbackModel: text(item.fallbackModel),
      state: normalizeAgentState(item.state),
      queuedAt: finite(item.queuedAt),
      startedAt: finite(item.startedAt),
      completedAt: finite(item.completedAt),
      attempt: finite(item.attempt),
      lastToolName: text(item.lastToolName),
      lastToolSummary: text(item.lastToolSummary),
      promptPreview: text(item.promptPreview),
      resultPreview: text(item.resultPreview),
      tokens: finite(item.tokens),
      toolCalls: finite(item.toolCalls),
      durationMs: finite(item.durationMs),
    }))
    .sort((a, b) => a.index - b.index);

  const taskId = text(raw.taskId) ?? fallbackTaskId;
  const summary =
    text(raw.summary) ??
    text(raw.description) ??
    text(raw.workflowName) ??
    '动态工作流';
  const timestamp = text(raw.timestamp);
  const completedAt = timestamp ? Date.parse(timestamp) : undefined;
  const explicitStatus = normalizeRunStatus(raw.status);
  const inferredStatus = agents.length
    ? agents.every((agent) => agent.state === 'done')
      ? 'completed'
      : agents.some((agent) => agent.state === 'failed')
        ? 'failed'
        : 'running'
    : explicitStatus;

  return {
    taskId,
    runId: text(raw.runId),
    workflowName: text(raw.workflowName),
    summary,
    status: explicitStatus === 'unknown' ? inferredStatus : explicitStatus,
    startTime: finite(raw.startTime),
    completedAt:
      completedAt !== undefined && Number.isFinite(completedAt)
        ? completedAt
        : undefined,
    durationMs: finite(raw.durationMs),
    agentCount: finite(raw.agentCount) ?? (agents.length || undefined),
    totalTokens: finite(raw.totalTokens),
    totalToolCalls: finite(raw.totalToolCalls),
    phases: [...phasesByIndex.values()].sort((a, b) => a.index - b.index),
    agents,
  };
}

function sessionProjectRoots(
  groupFolder: string,
  agentId: string | null,
): string[] {
  const claudeRoot = agentId
    ? path.join(DATA_DIR, 'sessions', groupFolder, 'agents', agentId, '.claude')
    : path.join(DATA_DIR, 'sessions', groupFolder, '.claude');
  const projectsRoot = path.join(claudeRoot, 'projects');
  try {
    return fs
      .readdirSync(projectsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(projectsRoot, entry.name));
  } catch {
    return [];
  }
}

export function loadSessionWorkflowRuns(input: {
  groupFolder: string;
  agentId: string | null;
  sessionId: string;
}): WorkflowRunSnapshot[] {
  const dirs = sessionProjectRoots(input.groupFolder, input.agentId)
    .map((projectRoot) => path.join(projectRoot, input.sessionId, 'workflows'))
    .filter((dir) => fs.existsSync(dir));
  const files = dirs.flatMap((dir) =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^wf_.+\.json$/.test(entry.name))
      .map((entry) => path.join(dir, entry.name)),
  );
  const signature = files
    .map((file) => {
      const stat = fs.statSync(file);
      return `${file}:${stat.mtimeMs}:${stat.size}`;
    })
    .join('|');
  const cacheKey = `${input.groupFolder}:${input.agentId ?? 'main'}:${input.sessionId}`;
  const cached = cache.get(cacheKey);
  if (cached?.signature === signature) return cached.runs;

  const runs = files
    .map((file) => {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<
          string,
          unknown
        >;
        return normalizeWorkflowRun(raw, path.basename(file, '.json'));
      } catch {
        return null;
      }
    })
    .filter((run): run is WorkflowRunSnapshot => run !== null)
    .sort(
      (a, b) =>
        (a.startTime ?? a.completedAt ?? 0) -
        (b.startTime ?? b.completedAt ?? 0),
    );
  cache.set(cacheKey, { signature, runs });
  return runs;
}

/** Attach completed Workflow snapshots to the assistant message that delivered them. */
export function attachSessionWorkflowRuns<T extends MessageLike>(
  messages: T[],
  input: { groupFolder: string; agentId: string | null },
): T[] {
  if (messages.length === 0) return messages;
  const bySession = new Map<string, T[]>();
  for (const message of messages) {
    if (!message.session_id || !message.is_from_me) continue;
    const list = bySession.get(message.session_id) ?? [];
    list.push(message);
    bySession.set(message.session_id, list);
  }
  let changed = false;
  const cloned = new Map<string, T>();
  for (const [sessionId, assistantMessages] of bySession) {
    const ensureClone = (message: T): T => {
      const existing = cloned.get(message.id);
      if (existing) return existing;
      const next = {
        ...message,
        workflow_runs: [...(message.workflow_runs ?? [])],
      };
      cloned.set(message.id, next);
      changed = true;
      return next;
    };
    // ISSUE-07 项6（用户决策 A）：sdk_message_uuid 用量回补已下线。runner 从不
    // 设置该 id（Pi 无消息 id 透传），列恒空；usage 已随 Pi 最终帧直存。
    const runs = loadSessionWorkflowRuns({ ...input, sessionId });
    const ordered = [...assistantMessages].sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
    );
    for (const run of runs) {
      const completedAt = run.completedAt ?? run.startTime ?? 0;
      const target =
        ordered.find(
          (message) => Date.parse(message.timestamp) >= completedAt,
        ) ?? ordered.at(-1);
      if (!target) continue;
      let next = cloned.get(target.id);
      if (!next) {
        next = ensureClone(target);
      }
      if (!next.workflow_runs!.some((item) => item.taskId === run.taskId)) {
        next.workflow_runs!.push(run);
      }
    }
  }
  return changed
    ? messages.map((message) => cloned.get(message.id) ?? message)
    : messages;
}
