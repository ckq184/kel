/**
 * Fail-closed proof that external MCP tools flow through the approval gate,
 * plus a live stdio-server test that the env-driven MCP loader registers
 * tools under Pi's `mcp__<server>__<tool>` naming with direct exposure.
 *
 * Part 1 loads the REAL extension chain (approval gate + loop guard via jiti,
 * MCP extension inline) through the REAL resource loader and dispatches
 * `tool_call` events through ExtensionRunner — the same dispatch Pi uses for
 * every tool call, MCP included. A gate that silently stopped covering MCP
 * names fails here.
 *
 * Part 2 boots the real Pi session stack against a fixture stdio MCP server
 * (no model calls) and asserts the tool becomes active as `mcp__fake__echo`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from '@earendil-works/pi-coding-agent';

import {
  setApprovalIpcRoot,
  setApprovalPolicy,
} from '../src/approval/policy.js';
import {
  MCP_SERVERS_ENV,
  createMiniclawMcpExtension,
} from '../src/runtime/pi/pi-mcp.js';

const approvalGatePath = fileURLToPath(
  new URL('../src/approval/extension.ts', import.meta.url),
);
const loopGuardPath = fileURLToPath(
  new URL('../src/approval/loop-guard.ts', import.meta.url),
);
const fakeServerPath = fileURLToPath(
  new URL('./fixtures/fake-mcp-stdio-server.mjs', import.meta.url),
);

let tempRoot: string;

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-pi-mcp-'));
  setApprovalIpcRoot(path.join(tempRoot, 'ipc'));
});

afterAll(async () => {
  // Best-effort: on Windows the fixture MCP server's stdio handles can
  // outlive dispose for a moment; a stuck temp dir must not fail the suite.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
});

async function buildRunner(policy: Record<string, unknown>) {
  setApprovalPolicy(policy as never);
  const agentDir = path.join(tempRoot, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, 'auth.json'),
    modelsPath: path.join(agentDir, 'models.json'),
    refreshOnCreate: false,
  });
  // The MCP extension is deliberately NOT loaded here: its own tool_call
  // handler needs an initialized extension runtime (bound by
  // AgentSession.bindExtensions), and the fail-closed question — does the
  // GATE intercept mcp__-shaped tool names — is name-based. The full MCP
  // chain is exercised by the live-session test below.
  const loader = new DefaultResourceLoader({
    cwd: tempRoot,
    agentDir,
    settingsManager: SettingsManager.create(tempRoot, agentDir),
    additionalExtensionPaths: [approvalGatePath, loopGuardPath],
  });
  await loader.reload({ resolveProjectTrust: async () => true });
  const extensionsResult = loader.getExtensions();
  expect(extensionsResult.errors).toEqual([]);
  const runner = new ExtensionRunner(
    extensionsResult.extensions,
    extensionsResult.runtime,
    tempRoot,
    SessionManager.inMemory(tempRoot),
    new ModelRegistry(modelRuntime),
  );
  return { runner, modelRuntime, loader };
}

describe('approval gate covers external MCP tool calls (fail-closed)', () => {
  test('namespaced tool is denied via the bare policy key', async () => {
    const { runner } = await buildRunner({
      tools: { browser_evaluate: 'deny' },
    });
    const result = await runner.emitToolCall({
      type: 'tool_call',
      toolCallId: 'gate-1',
      toolName: 'mcp__playwright__browser_evaluate',
      input: { script: '1+1' },
    });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('browser_evaluate');
  });

  test('namespaced tool is denied via a full-name policy key', async () => {
    const { runner } = await buildRunner({
      tools: { mcp__playwright__browser_evaluate: 'deny' },
    });
    const result = await runner.emitToolCall({
      type: 'tool_call',
      toolCallId: 'gate-2',
      toolName: 'mcp__playwright__browser_evaluate',
      input: {},
    });
    expect(result?.block).toBe(true);
  });

  test('unlisted namespaced tool passes under a permissive policy', async () => {
    const { runner } = await buildRunner({ tools: {} });
    const result = await runner.emitToolCall({
      type: 'tool_call',
      toolCallId: 'gate-3',
      toolName: 'mcp__searxng__searxng_web_search',
      input: { q: 'test' },
    });
    expect(result?.block).toBeFalsy();
  });

  test('default deny policy has no namespace gap', async () => {
    const { runner } = await buildRunner({ default: 'deny' });
    const result = await runner.emitToolCall({
      type: 'tool_call',
      toolCallId: 'gate-4',
      toolName: 'mcp__anything__arbitrary_tool',
      input: {},
    });
    expect(result?.block).toBe(true);
  });
});

describe('env-driven MCP loader in a real Pi session', () => {
  test(
    'registers the fixture server tool as mcp__fake__echo with direct exposure',
    { timeout: 30_000 },
    async () => {
      const previousEnv = process.env[MCP_SERVERS_ENV];
      process.env[MCP_SERVERS_ENV] = JSON.stringify({
        fake: { command: process.execPath, args: [fakeServerPath] },
      });
      const agentDir = path.join(tempRoot, 'agent');
      const modelRuntime = await ModelRuntime.create({
        authPath: path.join(agentDir, 'auth.json'),
        modelsPath: path.join(agentDir, 'models.json'),
        refreshOnCreate: false,
      });
      modelRuntime.registerProvider('miniclaw-mcp-test', {
        name: 'Miniclaw MCP test provider',
        baseUrl: 'http://127.0.0.1:9',
        api: 'anthropic-messages',
        models: [
          {
            id: 'test-model',
            name: 'test-model',
            api: 'anthropic-messages',
            reasoning: true,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 100_000,
            maxTokens: 1_000,
          },
        ],
      });
      const model = modelRuntime.getModel('miniclaw-mcp-test', 'test-model');
      expect(model).toBeTruthy();
      const loader = new DefaultResourceLoader({
        cwd: tempRoot,
        agentDir,
        settingsManager: SettingsManager.create(tempRoot, agentDir),
        additionalExtensionPaths: [approvalGatePath, loopGuardPath],
        extensionFactories: [createMiniclawMcpExtension()],
      });
      await loader.reload({ resolveProjectTrust: async () => true });
      const { session } = await createAgentSession({
        cwd: tempRoot,
        agentDir,
        modelRuntime,
        model,
        tools: ['read', 'mcp__*'],
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(tempRoot),
      });
      try {
        await session.bindExtensions({});
        // The MCP extension connects stdio servers in the background after
        // session_start; direct-exposure tools become active once connected.
        const deadline = Date.now() + 20_000;
        let names: string[] = [];
        while (Date.now() < deadline) {
          names = session.getActiveToolNames();
          if (names.includes('mcp__fake__echo')) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        expect(names).toContain('mcp__fake__echo');
        expect(names).toContain('read');
      } finally {
        session.dispose();
        if (previousEnv === undefined) delete process.env[MCP_SERVERS_ENV];
        else process.env[MCP_SERVERS_ENV] = previousEnv;
      }
    },
  );
});
