/**
 * CKQClaw's production Agent Runner entry point.
 *
 * This module intentionally imports only the runtime-neutral contracts, Pi,
 * and the existing capability/IPC layer. The former Claude runner remains in
 * src/index.ts as a source-level rollback reference, but the container starts
 * this file so the production execution path cannot load the Claude SDK.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContainerInput, ContainerOutput } from './types.js';
import {
  formatChannelTurnContextForPrompt,
  normalizeChannelTurnContext,
} from './types.js';
import {
  IpcTurnDeliveryTracker,
  latestIpcDeliveryId,
  latestIpcInputMessage,
  orderIpcInputMessages,
  parseIpcReceipt,
  type IpcInputMessage,
} from './ipc-delivery.js';
import {
  acknowledgeCkqclawOwnerProfileFirstWake,
  createMcpTools,
  fetchCkqclawOwnerProfileTurn,
  fetchWorkspaceMemorySnapshot,
  type McpContext,
} from './mcp-tools.js';
import { loadCkqclawOwnerProfileTurnContext } from './owner-profile-context.js';
import { loadWorkspaceMemoryTurnContext } from './workspace-memory-context.js';
import { buildCkqclawPromptPlan } from './prompt-plan.js';
import { resolveContextWindowOverride } from './context-window.js';
import { resolveAgentThinkingLevel } from './pi-settings.js';
import {
  MODEL_REQUIRED_MESSAGE,
  resolveClaudeProviderRuntime,
} from './provider-runtime.js';
import { resolveAgentRuntimeKind } from './runtime-config.js';
import { adaptClaudeMcpToolsToPi } from './runtime/pi/pi-tools.js';
import { parseCustomHeaders } from './runtime/pi/pi-provider.js';
import { PiRuntimeAdapter } from './runtime/pi/pi-runtime.js';
import { runPiQueryAttempt } from './runtime/pi/pi-runner.js';
import { stampStreamEventIdentity } from './stream-stamp.js';

const WORKSPACE_GROUP =
  process.env.CKQCLAW_WORKSPACE_GROUP || '/workspace/group';
const WORKSPACE_IPC =
  process.env.CKQCLAW_WORKSPACE_IPC ||
  process.env.CKQCLAW_WORKSPACE_IPC ||
  '/workspace/ipc';
const INPUT_DIR = path.join(WORKSPACE_IPC, 'input');
const CLOSE_SENTINEL = path.join(INPUT_DIR, '_close');
const INTERRUPT_SENTINEL = path.join(INPUT_DIR, '_interrupt');
const DRAIN_SENTINEL = path.join(INPUT_DIR, '_drain');
const OUTPUT_START = '---CKQCLAW_OUTPUT_START---';
const OUTPUT_END = '---CKQCLAW_OUTPUT_END---';
const DEFAULT_ALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'mcp__ckqclaw__*',
  // External MCP servers configured via /mcp-servers (host-injected env).
  // Pi filters MCP tools once any mcp__-prefixed entry is present, so the
  // wildcard must be explicit.
  'mcp__*',
];
const PROMPTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'prompts',
);

let activeInputTurnId: string | undefined;
let latestSessionId: string | undefined;

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function logWarn(message: string): void {
  console.error(`[agent-runner:warn] ${message}`);
}

function writeOutput(output: ContainerOutput): void {
  const correlated = activeInputTurnId
    ? { ...output, inputTurnId: output.inputTurnId ?? activeInputTurnId }
    : output;
  console.log(OUTPUT_START);
  console.log(JSON.stringify(correlated));
  console.log(OUTPUT_END);
}

function loadPrompt(name: string): string {
  try {
    return fs.readFileSync(path.join(PROMPTS_DIR, name), 'utf8').trimEnd();
  } catch {
    return '';
  }
}

function generateTurnId(): string {
  return `ipc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (value += chunk));
    process.stdin.on('end', () => resolve(value));
    process.stdin.on('error', reject);
  });
}

function drainInput(): IpcInputMessage[] {
  fs.mkdirSync(INPUT_DIR, { recursive: true });
  const messages: IpcInputMessage[] = [];
  for (const name of fs
    .readdirSync(INPUT_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .sort()) {
    const file = path.join(INPUT_DIR, name);
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<
        string,
        unknown
      >;
      fs.unlinkSync(file);
      if (data.type !== 'message' || typeof data.text !== 'string') continue;
      messages.push({
        text: data.text,
        images: Array.isArray(data.images) ? data.images : undefined,
        queryRunId:
          typeof data.queryRunId === 'string' ? data.queryRunId : undefined,
        taskId: typeof data.taskId === 'string' ? data.taskId : undefined,
        sourceJid:
          typeof data.sourceJid === 'string' ? data.sourceJid : undefined,
        channelContext: normalizeChannelTurnContext(
          data.channelContext,
          typeof data.sourceJid === 'string' ? data.sourceJid : undefined,
        ),
        receipt: parseIpcReceipt(data.receipt),
      });
    } catch (error) {
      log(`Failed to process IPC input ${name}: ${String(error)}`);
      try {
        fs.unlinkSync(file);
      } catch {
        /* best effort */
      }
    }
  }
  return orderIpcInputMessages(messages);
}

function consumeSentinel(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  try {
    fs.unlinkSync(file);
  } catch {
    /* the next poll will retry */
  }
  return true;
}

function watcher(onChange: () => void): { close: () => void } {
  fs.mkdirSync(INPUT_DIR, { recursive: true });
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let fsWatcher: fs.FSWatcher | undefined;
  try {
    fsWatcher = fs.watch(INPUT_DIR, () => {
      if (!closed) onChange();
    });
  } catch {
    /* polling below is sufficient */
  }
  timer = setInterval(() => {
    if (!closed) onChange();
  }, 1000);
  timer.unref();
  return {
    close() {
      closed = true;
      fsWatcher?.close();
      if (timer) clearInterval(timer);
    },
  };
}

async function waitForNextInput(): Promise<
  (IpcInputMessage & { messages: IpcInputMessage[] }) | null
> {
  return new Promise((resolve) => {
    let done = false;
    const check = () => {
      if (done) return;
      if (consumeSentinel(CLOSE_SENTINEL) || consumeSentinel(DRAIN_SENTINEL)) {
        done = true;
        handle.close();
        resolve(null);
        return;
      }
      const messages = drainInput();
      if (!messages.length) return;
      done = true;
      handle.close();
      const last = latestIpcInputMessage(messages);
      resolve({
        text: messages.map((message) => message.text).join('\n'),
        images: messages.flatMap((message) => message.images || []),
        taskId: last?.taskId,
        sourceJid: last?.sourceJid,
        channelContext: last?.channelContext,
        messages,
      });
    };
    const handle = watcher(check);
    check();
  });
}

function applyTurnContext(
  input: ContainerInput,
  ctx: McpContext,
  message?: IpcInputMessage,
): void {
  if (!message) return;
  input.currentSourceJid = message.sourceJid || input.currentSourceJid;
  input.channelContext = message.channelContext || input.channelContext;
  input.messageTaskId = message.taskId;
  input.queryRunId = message.queryRunId || input.queryRunId;
  ctx.chatJid = input.currentSourceJid || input.chatJid;
  ctx.channelContext = input.channelContext;
  ctx.currentTaskId = message.taskId ?? null;
  ctx.currentInputTurnId =
    message.receipt?.deliveryId || message.queryRunId || input.turnId || null;
}

function buildSystemPrompt(input: ContainerInput, ctx: McpContext): string {
  const channel = (input.currentSourceJid || input.chatJid).split(':')[0];
  const channelPrompt = fs.existsSync(
    path.join(PROMPTS_DIR, 'channels', `${channel}.md`),
  )
    ? loadPrompt(`channels/${channel}.md`)
    : undefined;
  const identity = input.agentProfile?.identityPrompt?.trim();
  const plan = buildCkqclawPromptPlan({
    platformIdentity: input.agentProfile?.isDefault
      ? loadPrompt('identity.ckqclaw.md')
      : undefined,
    platformBootstrap:
      input.agentProfile?.isDefault && input.ckqclawOwnerProfileEnabled
        ? loadPrompt('bootstrap.ckqclaw.md')
        : undefined,
    agentIdentity: identity
      ? `<agent-identity profile_id="${input.agentProfile?.id}"><profile-prompt>${identity}</profile-prompt></agent-identity>`
      : undefined,
    interaction: loadPrompt('interaction.md'),
    security: loadPrompt('security-rules.md'),
    memory: {
      id: 'memory-system.workspace',
      text: loadPrompt('memory-system.workspace.md'),
    },
    agentBuilder: input.agentBuilderEnabled
      ? loadPrompt('agent-builder.md')
      : undefined,
    output: input.isScheduledTask
      ? loadPrompt('output.task.md')
      : input.interactionMode === 'proactive'
        ? loadPrompt('output.proactive.md')
        : loadPrompt('output.assistant.md'),
    backgroundTasks: DEFAULT_ALLOWED_TOOLS.includes('Task')
      ? loadPrompt('background-tasks.md')
      : undefined,
    channel: channelPrompt
      ? {
          id: channel,
          text: `${channelPrompt}\n${formatChannelTurnContextForPrompt(ctx.channelContext)}`,
        }
      : undefined,
    deliveryContract: loadPrompt(
      input.interactionMode === 'proactive'
        ? 'delivery-contract.proactive.md'
        : 'delivery-contract.assistant.md',
    ),
  });
  for (const warning of plan.warnings) logWarn(warning);
  if (plan.errors.length)
    throw new Error(`prompt_plan_invalid: ${plan.errors.join('; ')}`);
  return plan.text;
}

async function runTurn(
  input: ContainerInput,
  ctx: McpContext,
  prompt: string,
  images: ContainerInput['images'],
  initialMessages: IpcInputMessage[],
): Promise<{
  closed: boolean;
  interrupted: boolean;
  pending: IpcInputMessage[];
}> {
  const [memory, owner] = await Promise.all([
    loadWorkspaceMemoryTurnContext(prompt, (query) =>
      fetchWorkspaceMemorySnapshot(ctx, query),
    ),
    loadCkqclawOwnerProfileTurnContext(() => fetchCkqclawOwnerProfileTurn(ctx)),
  ]);
  if (!memory.snapshot)
    logWarn(
      'Workspace memory snapshot unavailable; continuing without durable memory context',
    );
  const turnPrompt = [
    owner.block,
    memory.block,
    formatChannelTurnContextForPrompt(input.channelContext),
    prompt,
  ]
    .filter(Boolean)
    .join('\n\n');
  const tracker = new IpcTurnDeliveryTracker(initialMessages);
  const customTools = adaptClaudeMcpToolsToPi(createMcpTools(ctx), {
    namespace: 'mcp__ckqclaw',
  });
  const provider = resolveClaudeProviderRuntime(process.env);
  // ISSUE-18: Claude Code-style `Name: value` lines. Invalid lines are skipped
  // with a warning that names the line only, never the (possibly secret) value.
  const customHeaders = parseCustomHeaders(
    process.env.ANTHROPIC_CUSTOM_HEADERS,
  );
  for (const warning of customHeaders.warnings) {
    logWarn(
      `ANTHROPIC_CUSTOM_HEADERS line ${warning.line} skipped: ${warning.message}`,
    );
  }
  const runtime = new PiRuntimeAdapter();
  activeInputTurnId =
    latestIpcDeliveryId(initialMessages) || input.turnId || generateTurnId();
  ctx.currentInputTurnId = activeInputTurnId;
  let firstWakeAcknowledgementStarted = false;
  const result = await runPiQueryAttempt({
    runtime,
    sessionOptions: {
      cwd: WORKSPACE_GROUP,
      sessionDir: path.join(
        process.env.CLAUDE_CONFIG_DIR || path.join(WORKSPACE_GROUP, '.pi'),
        'sessions',
      ),
      sessionId: input.sessionId,
      model: provider.model || undefined,
      systemPrompt: buildSystemPrompt(input, ctx),
      allowedTools: DEFAULT_ALLOWED_TOOLS,
      customTools,
      provider: {
        endpointKind: provider.endpointKind,
        baseUrl: process.env.ANTHROPIC_BASE_URL,
        apiKey: process.env.ANTHROPIC_API_KEY,
        // Bearer token (ISSUE-04 ⑥) is folded into the registered
        // third-party key by resolvePiProvider (D-2 ②: official endpoints
        // are retired; there is no stored-anthropic-key path anymore).
        authToken: process.env.ANTHROPIC_AUTH_TOKEN,
        // ISSUE-04 ①: host-declared window is written into the registered
        // third-party model definition; undefined keeps its 200k default.
        contextWindow: resolveContextWindowOverride(
          provider.model,
          provider.declaredContextWindow,
        ),
        // ISSUE-18: only custom endpoint registrations consume these.
        headers: customHeaders.headers,
      },
      // ISSUE-04 ③: effort → thinkingLevel. Agent-level wins, the provider
      // env is the fallback, undefined defers to Pi's own default.
      thinkingLevel: resolveAgentThinkingLevel(
        input.agentProfile?.effort,
        process.env.CLAUDE_CODE_EFFORT_LEVEL,
      ),
      skillPaths: [
        path.join(process.env.CLAUDE_CONFIG_DIR || '', 'skills'),
        path.join(WORKSPACE_GROUP, '.claude', 'skills'),
      ].filter((entry) => entry && fs.existsSync(entry)),
      // The historical auto-compact percentage/window settings were retired
      // from the UI (ISSUE-04 ⑤): the product keeps compaction enabled and
      // Pi decides its own reserve-based threshold. An explicit runtime-level
      // disable remains expressible through the runtime contract.
      autoCompactEnabled: true,
    },
    prompt: turnPrompt,
    images,
    containerInput: input,
    tracker,
    emit: (output) => {
      // ISSUE-02 P0-1: every stream event leaves this runner carrying the
      // exact query identity, in one place — the host fence (observeExact on
      // queryRunId) and every turn-keyed consumer rely on it. Pre-existing
      // values (the interrupted event attaches its own) are never overwritten.
      if (output.streamEvent) {
        output = {
          ...output,
          streamEvent: stampStreamEventIdentity(output.streamEvent, {
            turnId: activeInputTurnId,
            queryRunId: input.queryRunId,
          }),
        };
      }
      if (
        !firstWakeAcknowledgementStarted &&
        owner.result?.firstWake === true &&
        output.streamEvent?.eventType === 'text_delta'
      ) {
        const leaseToken = owner.result.projection.onboarding.leaseToken;
        firstWakeAcknowledgementStarted = true;
        if (
          typeof leaseToken === 'number' &&
          Number.isInteger(leaseToken) &&
          leaseToken > 0
        ) {
          void acknowledgeCkqclawOwnerProfileFirstWake(
            ctx,
            leaseToken,
            activeInputTurnId || input.turnId || generateTurnId(),
          ).catch(() => undefined);
        }
      }
      if (input.interactionMode === 'proactive' && output.result) {
        writeOutput({
          ...output,
          result: null,
          proactiveFinalCandidate: output.result,
        });
      } else {
        writeOutput(output);
      }
    },
    log,
    drainInput,
    shouldClose: () =>
      consumeSentinel(CLOSE_SENTINEL) || consumeSentinel(DRAIN_SENTINEL),
    shouldInterrupt: () => consumeSentinel(INTERRUPT_SENTINEL),
    acceptIpcMessagesDuringQuery: true,
    onSessionId: (sessionId) => {
      input.sessionId = sessionId;
      latestSessionId = sessionId;
      ctx.currentSessionId = sessionId;
    },
    onTurnActivated: (messages) => {
      const message = latestIpcInputMessage(messages);
      activeInputTurnId =
        latestIpcDeliveryId(messages) || input.turnId || generateTurnId();
      applyTurnContext(input, ctx, message);
    },
    onTurnCompleted: () => {
      input.turnId = generateTurnId();
    },
  });
  return {
    closed: result.closedDuringQuery,
    interrupted: result.interruptedDuringQuery,
    pending: result.pipedMessagesDuringQuery,
  };
}

async function main(): Promise<void> {
  const input = JSON.parse(await readStdin()) as ContainerInput;
  input.turnId ||= generateTurnId();
  fs.mkdirSync(INPUT_DIR, { recursive: true });
  if (resolveAgentRuntimeKind(process.env) !== 'pi') {
    throw new Error(
      'AGENT_RUNTIME=claude is no longer supported; set AGENT_RUNTIME=pi or remove the environment variable.',
    );
  }
  const provider = resolveClaudeProviderRuntime(process.env);
  // D-2 ② (THESIS-04): official endpoints and missing base URLs are
  // configuration errors, reported before any session or provider work starts.
  if (provider.providerError) {
    writeOutput({
      status: 'error',
      result: null,
      error: provider.providerError,
    });
    process.exitCode = 1;
    return;
  }
  if (provider.missingRequiredModel) {
    writeOutput({
      status: 'error',
      result: null,
      error: MODEL_REQUIRED_MESSAGE,
    });
    process.exitCode = 1;
    return;
  }
  const ctx: McpContext = {
    chatJid: input.currentSourceJid || input.chatJid,
    channelContext: input.channelContext,
    groupFolder: input.groupFolder,
    isHome: input.isHome ?? input.isMain ?? false,
    agentBuilderEnabled: input.agentBuilderEnabled ?? false,
    ownerProfileEnabled: input.ckqclawOwnerProfileEnabled === true,
    interactionMode: input.interactionMode ?? 'assistant',
    isScheduledTask: input.isScheduledTask === true,
    currentTaskId: input.messageTaskId ?? null,
    currentInputTurnId: input.turnId,
    currentSessionId: input.sessionId ?? null,
    workspaceMemoryMutationAuth:
      input.workspaceMemoryMutationSigningSecret &&
      input.workspaceMemoryRunnerInstanceId
        ? {
            runnerInstanceId: input.workspaceMemoryRunnerInstanceId,
            secret: input.workspaceMemoryMutationSigningSecret,
            agentId: input.agentId ?? null,
            taskRunId: input.taskRunId ?? null,
          }
        : undefined,
    workspaceIpc: WORKSPACE_IPC,
    workspaceGroup: WORKSPACE_GROUP,
  };
  let prompt = input.prompt;
  let images = input.images;
  let initialMessages = drainInput();
  if (initialMessages.length) {
    const last = latestIpcInputMessage(initialMessages);
    applyTurnContext(input, ctx, last);
    prompt = `${prompt}\n${initialMessages.map((message) => message.text).join('\n')}`;
    images = [
      ...(images || []),
      ...initialMessages.flatMap((message) => message.images || []),
    ];
  }
  try {
    while (true) {
      const result = await runTurn(input, ctx, prompt, images, initialMessages);
      if (result.pending.length) {
        log(
          `Re-queueing ${result.pending.length} unacknowledged IPC message(s)`,
        );
        for (const message of result.pending) {
          const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
          fs.writeFileSync(
            path.join(INPUT_DIR, name),
            JSON.stringify({ type: 'message', ...message }),
          );
        }
      }
      if (result.closed) {
        writeOutput({
          status: 'closed',
          result: null,
          newSessionId: latestSessionId,
        });
        return;
      }
      if (result.interrupted) {
        log('Pi turn interrupted; waiting for the next input');
      }
      const next = await waitForNextInput();
      if (!next) return;
      prompt = next.text;
      images = next.images;
      initialMessages = next.messages;
      input.turnId = generateTurnId();
      applyTurnContext(input, ctx, latestIpcInputMessage(next.messages));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Agent error: ${message}`);
    if (error instanceof Error && error.stack)
      log(`Agent error stack:\n${error.stack}`);
    writeOutput({
      status: 'error',
      result: null,
      error: message,
      newSessionId: latestSessionId,
    });
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[agent-runner] Fatal error in Pi main: ${String(error)}`);
  process.exit(1);
});
