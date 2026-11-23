import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';

import { resolvePiProvider } from '../container/agent-runner/src/runtime/pi/pi-provider.js';
import { createSubagentInheritModelExtension } from '../container/agent-runner/src/runtime/pi/pi-subagents.js';
import {
  describeSubagentFailure,
  runPiQueryAttempt,
} from '../container/agent-runner/src/runtime/pi/pi-runner.js';
import { IpcTurnDeliveryTracker } from '../container/agent-runner/src/ipc-delivery.js';
import type {
  ContainerInput,
  ContainerOutput,
  StreamEvent,
} from '../container/agent-runner/src/types.js';
import type {
  AgentRuntime,
  RuntimeEvent,
  RuntimeSession,
} from '../container/agent-runner/src/runtime/types.js';
// The third-party resolver the Agent tool uses, imported only to lock the
// resolution outcome; production code never imports pi-subagents internals.
import { resolveModel } from '../container/agent-runner/node_modules/@tintinweb/pi-subagents/dist/model-resolver.js';

/**
 * ISSUE-22: subagents spawned under a custom Anthropic-compatible endpoint
 * must inherit the parent model instead of resolving to Pi's built-in
 * Anthropic catalog (which the leaked ANTHROPIC_API_KEY env marks available).
 */

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_OAUTH_TOKEN',
] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    Reflect.deleteProperty(process.env, key);
  }
  // Same shape as production: the host leaves the custom endpoint's key in
  // the runner environment. A fake value — no request is ever sent.
  process.env.ANTHROPIC_API_KEY = 'test-only-not-a-real-key';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = savedEnv[key];
  }
});

async function createModelRuntime(): Promise<ModelRuntime> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckqclaw-pi-issue22-'));
  const authPath = path.join(dir, 'auth.json');
  const modelsPath = path.join(dir, 'models.json');
  fs.writeFileSync(authPath, '{}\n');
  fs.writeFileSync(modelsPath, '{}\n');
  return ModelRuntime.create({ authPath, modelsPath, refreshOnCreate: false });
}

const EXPLORE_MODEL = 'anthropic/claude-haiku-4-5';

describe('ISSUE-22 T1 custom endpoint narrows subagent model availability', () => {
  test('custom endpoint: only the ckqclaw provider is available and Explore cannot resolve to Anthropic', async () => {
    const runtime = await createModelRuntime();
    const resolution = await resolvePiProvider(runtime, {
      model: 'test-model',
      endpointKind: 'custom',
      baseUrl: 'https://proxy.invalid',
      apiKey: 'test-only-not-a-real-key',
    });
    // Refresh the availability snapshot the way a live session does.
    await runtime.getAvailable();
    const registry = new ModelRegistry(runtime);

    const providers = new Set(registry.getAvailable().map((m) => m.provider));
    expect([...providers]).toEqual(['ckqclaw-anthropic']);

    // Agent tool: a config model that does not resolve falls back to the parent.
    const explore = resolveModel(EXPLORE_MODEL, registry);
    if (typeof explore !== 'string') {
      // A fuzzy hit is only acceptable when it is the parent model itself.
      expect(explore.provider).toBe('ckqclaw-anthropic');
    }
    const sonnet = resolveModel('sonnet', registry);
    if (typeof sonnet !== 'string') {
      expect(sonnet.provider).toBe('ckqclaw-anthropic');
    }
    expect(resolution.custom).toBe(true);
  });

  test('official endpoint keeps the built-in Anthropic catalog available (Explore uses haiku)', async () => {
    const runtime = await createModelRuntime();
    const resolution = await resolvePiProvider(runtime, {
      model: 'claude-sonnet-4-5',
      endpointKind: 'official',
    });
    await runtime.getAvailable();
    const registry = new ModelRegistry(runtime);

    const explore = resolveModel(EXPLORE_MODEL, registry);
    expect(typeof explore).not.toBe('string');
    expect(explore.provider).toBe('anthropic');
    expect(explore.id).toMatch(/haiku-4-5/);
    expect(resolution.custom).toBe(false);
  });
});

type ToolCallHandler = (event: {
  type: 'tool_call';
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}) => unknown;

async function loadToolCallHandlers(): Promise<ToolCallHandler[]> {
  const handlers: ToolCallHandler[] = [];
  const fakePi = {
    on(event: string, handler: ToolCallHandler) {
      if (event === 'tool_call') handlers.push(handler);
      return () => {};
    },
  };
  await createSubagentInheritModelExtension()(fakePi as never);
  return handlers;
}

describe('ISSUE-22 T2 explicit Agent model is dropped under a custom endpoint', () => {
  test('removes model from Agent calls and keeps every other argument', async () => {
    const handlers = await loadToolCallHandlers();
    expect(handlers).toHaveLength(1);
    const input: Record<string, unknown> = {
      subagent_type: 'general-purpose',
      prompt: 'p',
      description: 'd',
      model: 'sonnet',
      run_in_background: true,
    };
    const result = await handlers[0]({
      type: 'tool_call',
      toolCallId: 't1',
      toolName: 'Agent',
      input,
    });
    expect(result).toBeUndefined();
    expect(input).toEqual({
      subagent_type: 'general-purpose',
      prompt: 'p',
      description: 'd',
      run_in_background: true,
    });
  });

  test('leaves other tools untouched', async () => {
    const [handler] = await loadToolCallHandlers();
    const input = { command: 'ls', model: 'keep-me' };
    await handler({
      type: 'tool_call',
      toolCallId: 't2',
      toolName: 'bash',
      input,
    });
    expect(input).toEqual({ command: 'ls', model: 'keep-me' });
  });

  test('pi-runtime loads the extension only for custom endpoints', () => {
    const source = fs.readFileSync(
      path.resolve(
        __dirname,
        '../container/agent-runner/src/runtime/pi/pi-runtime.ts',
      ),
      'utf-8',
    );
    expect(source).toMatch(
      /modelResolution\.custom\s*\?\s*\[createSubagentInheritModelExtension\(\)\]/,
    );
    // Both loader constructions (with and without the subagent extension)
    // share the same factory list.
    const factoryUses = source.match(
      /extensionFactories: extensionFactories\(\)/g,
    );
    expect(factoryUses).toHaveLength(2);
  });
});

const RAW_401 =
  '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_test"}';

describe('ISSUE-22 T3 readable subagent auth failures', () => {
  test('auth failures become a short Chinese hint with the status code', () => {
    expect(describeSubagentFailure(RAW_401)).toBe(
      '子代理鉴权失败（401）：请检查 Provider 凭据与端点配置',
    );
    expect(
      describeSubagentFailure(
        '403 {"type":"error","error":{"type":"permission_error","message":"x"}}',
      ),
    ).toBe('子代理鉴权失败（403）：请检查 Provider 凭据与端点配置');
    expect(
      describeSubagentFailure(
        'Error: {"type":"error","error":{"type":"authentication_error"}}',
      ),
    ).toBe('子代理鉴权失败：请检查 Provider 凭据与端点配置');
  });

  test('other errors pass through unchanged', () => {
    for (const error of [
      '429 rate limited',
      '500 {"type":"error","error":{"type":"api_error"}}',
      'subagent aborted',
      'tool 401 lines changed',
    ]) {
      expect(describeSubagentFailure(error)).toBe(error);
    }
  });

  function fakeSession(events: RuntimeEvent[]): RuntimeSession {
    const listeners = new Set<(event: RuntimeEvent) => void>();
    return {
      kind: 'pi',
      sessionId: 'pi-sess-22',
      get isStreaming() {
        return false;
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async prompt() {
        for (const event of [
          ...events,
          {
            type: 'result',
            sessionId: 'pi-sess-22',
            result: {
              text: 'ok',
              sessionId: 'pi-sess-22',
              finalizationReason: 'completed',
              stopReason: 'stop',
            },
          } as RuntimeEvent,
        ]) {
          for (const listener of listeners) listener(event);
        }
      },
      async steer() {},
      async followUp() {},
      async abort() {},
      async compact() {},
      dispose() {},
    } satisfies RuntimeSession;
  }

  async function run(events: RuntimeEvent[]) {
    const outputs: ContainerOutput[] = [];
    const logs: string[] = [];
    await runPiQueryAttempt({
      runtime: {
        createSession: async () => fakeSession(events),
      } as AgentRuntime,
      sessionOptions: { cwd: '/tmp', sessionDir: '/tmp/pi' },
      prompt: 'user message',
      containerInput: {
        prompt: 'user message',
        groupFolder: 'test',
        chatJid: 'test:chat',
      } as ContainerInput,
      tracker: new IpcTurnDeliveryTracker(),
      emit: (output) => outputs.push(output),
      log: (message) => logs.push(message),
      drainInput: () => [],
      shouldClose: () => false,
      shouldInterrupt: () => false,
      acceptIpcMessagesDuringQuery: false,
      onSessionId: () => {},
      onTurnActivated: () => {},
      onTurnCompleted: () => {},
    });
    const tasks = outputs
      .flatMap((output) => (output.streamEvent ? [output.streamEvent] : []))
      .filter((event: StreamEvent) => event.eventType === 'task_progress');
    return { tasks, logs };
  }

  test('failed subagent card row shows the hint and the raw error goes to the runner log', async () => {
    const { tasks, logs } = await run([
      {
        type: 'subagent',
        sessionId: 'pi-sess-22',
        lifecycle: 'failed',
        agentId: 'agent-1',
        error: RAW_401,
        details: { description: '查找文件', type: 'Explore' },
      },
    ]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskStatus).toBe('failed');
    expect(tasks[0].taskSummary).toBe(
      '子代理鉴权失败（401）：请检查 Provider 凭据与端点配置',
    );
    const rawLogs = logs.filter((line) => line.includes('invalid x-api-key'));
    expect(rawLogs).toHaveLength(1);
    expect(rawLogs[0]).toContain('agent-1');
  });

  test('completed results and non-auth failures keep their text and add no log', async () => {
    const { tasks, logs } = await run([
      {
        type: 'subagent',
        sessionId: 'pi-sess-22',
        lifecycle: 'completed',
        agentId: 'agent-2',
        result: '401 lines reviewed: authentication_error handling looks fine',
      },
      {
        type: 'subagent',
        sessionId: 'pi-sess-22',
        lifecycle: 'failed',
        agentId: 'agent-3',
        error: '500 upstream error',
      },
    ]);
    expect(tasks.map((task) => task.taskSummary)).toEqual([
      '401 lines reviewed: authentication_error handling looks fine',
      '500 upstream error',
    ]);
    expect(logs.filter((line) => line.includes('subagent'))).toEqual([]);
  });
});
