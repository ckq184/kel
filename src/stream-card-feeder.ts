/**
 * Event → streaming-card mapping for both main and sub-agent handlers.
 *
 * Extracted verbatim from src/index.ts (ISSUE-03): index.ts runs main() at
 * module load, so its inline helpers were untestable; this module is the
 * machine-testable seam for the Feishu/QQ card event contract.
 */
import type { StreamEvent } from './stream-event.types.js';
import { logger } from './logger.js';
import { StreamingCardController } from './feishu-streaming-card.js';
import type { StreamingSession } from './im-channel.js';

/**
 * Feed a stream event into a Feishu streaming card controller.
 * Centralizes the event → card mapping for both main and sub-agent handlers.
 */
export function feedStreamEventToCard(
  session: StreamingSession,
  se: StreamEvent,
  accumulatedText: string,
  traceUrl?: string | null,
): void {
  if (traceUrl && session instanceof StreamingCardController) {
    session.setTraceUrl(traceUrl);
  }
  switch (se.eventType) {
    case 'text_delta':
      if (se.text) session.append(accumulatedText);
      break;
    case 'thinking_delta':
      // 子 Agent（SDK Task）的思考带 parentToolUseId，在 task 面板独立呈现；
      // 混入主卡思考面板会反复重新激活 thinking 态并污染内容（Web 端
      // applyStreamEvent 与服务端快照均已隔离，此处对齐）。
      if (se.parentToolUseId) break;
      if (se.text) {
        session.appendThinking(se.text);
      } else if (!accumulatedText) {
        // Only call setThinking() when no text was appended
        // (appendThinking already sets thinking=true and triggers card creation)
        session.setThinking();
      }
      break;
    case 'tool_use_start':
      if (se.toolUseId && se.toolName) {
        // Tool-only/model-reasoning turns may legally emit no text_delta for
        // minutes. Create the primary projection from deterministic host
        // activity instead of leaving the user with no card until Result.
        session.setThinking();
        session.startTool(se.toolUseId, se.toolName);
        // ISSUE-03: Pi attaches the full tool input on tool_use_start, so the
        // summary is available immediately instead of arriving via
        // tool_progress input_json deltas like the Claude path.
        if (se.toolInputSummary) {
          session.updateToolSummary(se.toolUseId, se.toolInputSummary);
        }
        // Feishu streaming card wants richer metadata (skillName / nested /
        // raw toolInput for AskUserQuestion). Attach separately so the
        // StreamingSession union's common signature stays tight.
        if (
          session instanceof StreamingCardController &&
          (se.skillName || se.isNested || se.toolInput)
        ) {
          session.setToolMeta(se.toolUseId, {
            skillName: se.skillName,
            isNested: se.isNested,
            toolInput: se.toolInput,
          });
        }
        const label = se.skillName ? `技能 ${se.skillName}` : se.toolName;
        session.setSystemStatus(`正在使用 ${label}…`);
        session.pushRecentEvent(`🔄 ${label}`);
      }
      break;
    case 'tool_use_end':
      if (se.toolUseId) {
        const info = session.getToolInfo(se.toolUseId);
        // ISSUE-03: honor the tool's own error flag instead of hardcoding a
        // success end, and surface the Pi-carried result on the same event.
        const toolError = se.isError === true;
        session.endTool(se.toolUseId, toolError);
        if (info) {
          session.pushRecentEvent(`${toolError ? '❌' : '✅'} ${info.name}`);
        }
        if (se.toolResult) {
          const resultLabel = info?.name ? `\`${info.name}\` ` : '';
          session.pushRecentEvent(
            `↳ <font color='grey'>结果</font> ${resultLabel}${se.toolResult.slice(0, 120)}`,
          );
        }
      }
      break;
    case 'tool_result': {
      // Surface the (truncated + sanitized) tool output in the timeline so the
      // card shows *what* a tool returned, aligning with Claude Code's trace.
      if (se.toolResult) {
        const resultInfo = se.toolUseId
          ? session.getToolInfo(se.toolUseId)
          : undefined;
        const toolLabel = resultInfo?.name ? `\`${resultInfo.name}\` ` : '';
        session.pushRecentEvent(
          `↳ <font color='grey'>结果</font> ${toolLabel}${se.toolResult.slice(0, 120)}`,
        );
      }
      break;
    }
    case 'tool_progress':
      if (se.toolUseId && se.toolInputSummary) {
        session.updateToolSummary(se.toolUseId, se.toolInputSummary);
      }
      // AskUserQuestion 等工具的结构化输入（questions/options）经 tool_progress
      // 的 toolInput 字段下发（非 toolInputSummary，因流式 tool_use_start 时 input 恒空）。
      // 写入 tc.toolInput 以驱动飞书 ASK 面板渲染，与 Web 端 applyStreamEvent 对齐。
      if (
        se.toolUseId &&
        se.toolInput &&
        session instanceof StreamingCardController
      ) {
        session.setToolMeta(se.toolUseId, { toolInput: se.toolInput });
      }
      break;
    case 'status':
      if (se.statusText && se.statusText !== 'interrupted') {
        session.setThinking();
        session.setSystemStatus(
          se.statusText === 'requesting'
            ? '正在处理…'
            : se.statusText === 'compacting'
              ? '正在整理上下文…'
              : se.statusText,
        );
      }
      break;
    case 'hook_started':
      session.setHook({
        hookName: se.hookName || '',
        hookEvent: se.hookEvent || '',
      });
      break;
    case 'hook_response':
      if (se.hookName) {
        session.pushRecentEvent(`✅ Hook: ${se.hookName}`);
      }
      session.setHook(null);
      break;
    case 'todo_update':
      if (se.todos) session.setTodos(se.todos);
      break;
    case 'task_start':
      if (se.toolUseId) {
        session.setThinking();
        const label = se.taskDescription
          ? `Task: ${se.taskDescription.slice(0, 40)}`
          : 'Task';
        if (session instanceof StreamingCardController) {
          session.updateTask(se.toolUseId, {
            title: se.taskDescription || se.toolInputSummary || 'Task',
            status: 'running',
            subagentType: se.subagentType,
            summary: se.summary,
          });
        }
        session.startTool(se.toolUseId, label);
        session.setSystemStatus(
          se.taskDescription
            ? `正在执行任务：${se.taskDescription.slice(0, 80)}`
            : '正在执行子任务…',
        );
        session.pushRecentEvent(`🚀 ${label}`);
      }
      break;
    case 'task_progress': {
      const id = se.toolUseId || se.taskId;
      if (id && session instanceof StreamingCardController) {
        // ISSUE-03: the subagent lifecycle broadcast carries the terminal
        // taskStatus — map it instead of pinning every update to 'running'.
        const terminalStatus =
          se.taskStatus === 'completed'
            ? 'completed'
            : se.taskStatus === 'failed'
              ? 'error'
              : 'running';
        session.updateTask(id, {
          // Only override the title when the broadcast actually carries a
          // description — a description-less 'started' must not regress the
          // card's existing title back to the 'Task' placeholder.
          ...(se.taskDescription ? { title: se.taskDescription } : {}),
          status: terminalStatus,
          subagentType: se.subagentType,
          lastToolName: se.lastToolName,
          summary: se.summary || se.taskSummary,
        });
        if (terminalStatus === 'running') {
          if (se.summary) {
            session.pushRecentEvent(`🔄 Task: ${se.summary.slice(0, 60)}`);
          }
        } else {
          const label = se.taskSummary
            ? `Task: ${se.taskSummary.slice(0, 40)}`
            : terminalStatus === 'error'
              ? 'Task 失败'
              : 'Task 完成';
          session.pushRecentEvent(
            `${terminalStatus === 'error' ? '❌' : '✅'} ${label}`,
          );
        }
      }
      break;
    }
    case 'task_updated': {
      const id = se.toolUseId || se.taskId;
      if (id && session instanceof StreamingCardController) {
        const patchStatus = se.taskPatch?.status;
        session.updateTask(id, {
          status:
            patchStatus === 'completed'
              ? 'completed'
              : patchStatus === 'failed' || patchStatus === 'killed'
                ? 'error'
                : se.taskPatch?.is_backgrounded
                  ? 'backgrounded'
                  : 'running',
          summary:
            se.summary || se.taskPatch?.description || se.taskPatch?.error,
        });
      }
      break;
    }
    case 'task_notification':
      if (se.toolUseId || se.taskId) {
        const id = se.toolUseId || se.taskId || '';
        if (session instanceof StreamingCardController) {
          session.updateTask(id, {
            status: se.taskStatus === 'completed' ? 'completed' : 'error',
            summary: se.taskSummary || se.summary,
          });
        }
        // ISSUE-03: keep the legacy branch coherent — an errored notification
        // must not render a success tool end. (Branch deletion is ISSUE-10.)
        session.endTool(id, se.taskStatus !== 'completed');
        const label = se.taskSummary
          ? `Task: ${se.taskSummary.slice(0, 40)}`
          : 'Task 完成';
        session.pushRecentEvent(`✅ ${label}`);
      }
      break;
    case 'hook_progress':
      // Update hook state (no card push needed — card already shows hook indicator)
      session.setHook({
        hookName: se.hookName || '',
        hookEvent: se.hookEvent || '',
      });
      break;
    case 'usage':
      if (se.usage) session.patchUsageNote(se.usage);
      break;
    case 'permission_denied': {
      // A denied tool call is a real signal (the agent wanted to do something
      // it wasn't allowed to) — render it in red so it stands out from the
      // grey routine-event stream instead of being buried as plain text.
      const pd = se.permissionDenied;
      const toolName = pd?.toolName || se.toolName || '';
      const reason = pd?.reason || pd?.message || se.summary || '';
      const toolPart = toolName ? ` \`${toolName}\`` : '';
      const reasonPart = reason
        ? ` <font color='grey'>${reason.slice(0, 80)}</font>`
        : '';
      session.pushRecentEvent(
        `🚫 <text_tag color='red'>权限拒绝</text_tag>${toolPart}${reasonPart}`,
      );
      break;
    }
    case 'memory_recall':
    case 'compact_boundary':
    case 'notification':
    case 'prompt_suggestion':
      if (se.summary || se.title) {
        // memory_recall / compact_boundary carry the matched memory or the
        // pre-compaction summary in `detail`; surface it (clamped) after the
        // headline so the runtime trace shows *what* was recalled/compacted,
        // not just that something happened.
        const detail = se.detail
          ? ` <font color='grey'>${se.detail.slice(0, 120)}</font>`
          : '';
        session.pushRecentEvent(
          `${se.title || se.eventType}: ${(se.summary || '').slice(0, 80)}${detail}`,
        );
      }
      if (se.eventType === 'compact_boundary') {
        session.setSystemStatus(se.summary || '上下文已压缩');
      }
      break;
    case 'context_audit':
      // Context audits describe CKQClaw/Claude runtime wiring. Keep them in
      // service logs for operators, but never leak framework internals into a
      // user's conversation or streaming card.
      if (se.contextAudit?.warnings?.length) {
        logger.warn(
          { warnings: se.contextAudit.warnings },
          'Agent context audit warning',
        );
      }
      break;
    case 'raw_sdk_event':
      if (se.displayLevel === 'primary') {
        session.pushRecentEvent(
          `${se.title || se.rawType || 'SDK'}: ${(se.summary || '').slice(0, 80)}`,
        );
      }
      break;
    case 'init':
      // Internal signal, no card display needed
      break;
  }
}
