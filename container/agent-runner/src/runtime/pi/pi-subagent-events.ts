import type { StreamEvent } from '../../types.js';
import type { RuntimeEvent } from '../types.js';
import { summarizeToolResult } from '../../utils.js';

type SubagentRuntimeEvent = Extract<RuntimeEvent, { type: 'subagent' }>;

const DESCRIPTION_MAX_CHARS = 200;

/** Short, fixed progress texts: steer/compact carry no text of their own. */
const PROGRESS_SUMMARIES = {
  steered: '子代理已收到新的引导消息',
  compacted: '子代理上下文已压缩',
} as const;

type RunningAgent = { description?: string; subagentType?: string };

/** Read a string field off the loosely typed lifecycle payload. */
function detailText(details: unknown, key: string): string | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const value = (details as Record<string, unknown>)[key];
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Translates pi-subagents lifecycle events into the Task contract the host,
 * Web and Feishu UIs read: `task_start` to open a task, `task_notification`
 * to close it, `task_progress` for in-flight notices.
 *
 * The task id is the pi-subagents agent id. The `Agent` tool call has its own
 * id and stays an ordinary tool card, so the two never need to be correlated.
 * State is per mapper: one mapper serves one Pi session.
 */
export function createSubagentEventMapper(): (
  event: SubagentRuntimeEvent,
) => StreamEvent | undefined {
  const running = new Map<string, RunningAgent>();
  const background = new Set<string>();

  return (event) => {
    const id = event.agentId;
    // Without an agent id there is nothing to key a task on.
    if (!id) return undefined;
    const base = {
      agentScope: 'task',
      displayLevel: 'primary',
      taskId: id,
      toolUseId: id,
      sessionId: event.sessionId,
    } as const;

    switch (event.lifecycle) {
      case 'created':
      case 'started': {
        // `created` is only sent for background agents, and may arrive after
        // `started`; either order opens the task exactly once.
        if (
          event.lifecycle === 'created' &&
          (event.details as { isBackground?: unknown } | undefined)
            ?.isBackground === true
        ) {
          background.add(id);
        }
        if (running.has(id)) return undefined;
        const description = detailText(event.details, 'description')?.slice(
          0,
          DESCRIPTION_MAX_CHARS,
        );
        const subagentType = detailText(event.details, 'type');
        running.set(id, { description, subagentType });
        return {
          eventType: 'task_start',
          ...base,
          taskType: 'subagent',
          ...(description ? { taskDescription: description } : {}),
          ...(subagentType ? { subagentType } : {}),
        };
      }
      case 'completed':
      case 'failed': {
        const failed = event.lifecycle === 'failed';
        const summary = summarizeToolResult(
          failed ? event.error || event.result : event.result,
        );
        const isBackground = background.has(id);
        running.delete(id);
        background.delete(id);
        return {
          eventType: 'task_notification',
          ...base,
          taskStatus: failed ? 'failed' : 'completed',
          ...(summary ? { taskSummary: summary, summary } : {}),
          ...(isBackground ? { isBackground: true } : {}),
        };
      }
      case 'steered':
      case 'compacted': {
        const agent = running.get(id);
        // Progress for an agent that never started or already ended would
        // resurrect a finished task in the UI.
        if (!agent) return undefined;
        const summary = PROGRESS_SUMMARIES[event.lifecycle];
        return {
          eventType: 'task_progress',
          ...base,
          // Re-sent because the Feishu card re-titles a task on every
          // progress event and falls back to a bare "Task" without it.
          ...(agent.description ? { taskDescription: agent.description } : {}),
          ...(agent.subagentType ? { subagentType: agent.subagentType } : {}),
          taskSummary: summary,
          summary,
        };
      }
    }
  };
}
