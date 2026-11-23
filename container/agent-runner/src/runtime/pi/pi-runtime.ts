import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type {
  AgentRuntime,
  RuntimeSession,
  RuntimeSessionOptions,
} from '../types.js';
import { resolvePiProvider } from './pi-provider.js';
import { createCkqclawMcpExtension } from './pi-mcp.js';
import { PiRuntimeSession } from './pi-session.js';

const require = createRequire(import.meta.url);

function existingPiSessionPath(
  sessionDir: string,
  sessionId: string,
): string | undefined {
  if (!sessionId || !fs.existsSync(sessionDir)) return undefined;
  const suffix = `_${sessionId}.jsonl`;
  const candidate = fs
    .readdirSync(sessionDir)
    .filter((name) => name.endsWith(suffix))
    .sort()
    .at(-1);
  return candidate ? path.join(sessionDir, candidate) : undefined;
}

function resolveSubagentsExtension(): string | undefined {
  // The package ships no "main" field: resolving the bare package name fails,
  // which silently dropped the extension in earlier versions. Its Pi entry
  // (`pi.extensions`) points at TS source; the compiled dist entry is the
  // stable load target for jiti.
  const candidates = [
    '@tintinweb/pi-subagents/dist/index.js',
    '@tintinweb/pi-subagents/src/index.ts',
  ];
  for (const candidate of candidates) {
    try {
      const entry = require.resolve(candidate);
      if (fs.existsSync(entry)) return entry;
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}

export class PiRuntimeAdapter implements AgentRuntime {
  readonly kind = 'pi' as const;

  async createSession(options: RuntimeSessionOptions): Promise<RuntimeSession> {
    const agentDir = path.join(options.sessionDir, '..', 'agent');
    fs.mkdirSync(options.sessionDir, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });

    const settingsManager = SettingsManager.create(options.cwd, agentDir, {
      projectTrusted: true,
    });
    // Product auto-compact toggle: OFF disables the runtime-native compaction;
    // ON (or unset) keeps Pi's native threshold-based compaction behavior.
    settingsManager.setCompactionEnabled(options.autoCompactEnabled !== false);
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, 'auth.json'),
      modelsPath: path.join(agentDir, 'models.json'),
      refreshOnCreate: false,
    });
    const modelResolution = await resolvePiProvider(modelRuntime, {
      model: options.model,
      endpointKind: options.provider?.endpointKind,
      baseUrl: options.provider?.baseUrl,
      apiKey: options.provider?.apiKey,
      // ISSUE-04 ①⑥: this adapter is the only hop between the runner session
      // options and the provider resolution. Dropping either field silently
      // reverts the host-declared context window and the bearer credential
      // routing, so both must be forwarded explicitly.
      authToken: options.provider?.authToken,
      contextWindow: options.provider?.contextWindow,
      // ISSUE-18: parsed ANTHROPIC_CUSTOM_HEADERS for custom endpoints.
      headers: options.provider?.headers,
    });

    const eventBus = createEventBus();
    const extensionPaths = [...(options.extensionPaths ?? [])];
    const subagentsExtension = resolveSubagentsExtension();
    if (subagentsExtension && !extensionPaths.includes(subagentsExtension)) {
      extensionPaths.push(subagentsExtension);
    }
    let resourceLoader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir,
      settingsManager,
      eventBus,
      systemPrompt: options.systemPrompt,
      additionalSkillPaths: options.skillPaths,
      additionalExtensionPaths: extensionPaths,
      // External MCP servers from the host-injected env config. SDK sessions
      // do not load built-in extensions, so the MCP extension must be added
      // explicitly.
      extensionFactories: [createCkqclawMcpExtension()],
    });
    try {
      await resourceLoader.reload({ resolveProjectTrust: async () => true });
    } catch (error) {
      // Pi remains usable when an optional extension is missing, malformed, or
      // incompatible. Do not silently downgrade to Claude; retrying without
      // only the optional subagent extension keeps the selected runtime
      // explicit and lets the regular tools fail visibly if requested.
      if (!subagentsExtension || !extensionPaths.includes(subagentsExtension)) {
        throw error;
      }
      const withoutSubagents = extensionPaths.filter(
        (entry) => entry !== subagentsExtension,
      );
      resourceLoader = new DefaultResourceLoader({
        cwd: options.cwd,
        agentDir,
        settingsManager,
        eventBus,
        systemPrompt: options.systemPrompt,
        additionalSkillPaths: options.skillPaths,
        additionalExtensionPaths: withoutSubagents,
        extensionFactories: [createCkqclawMcpExtension()],
      });
      await resourceLoader.reload({ resolveProjectTrust: async () => true });
    }

    const sessionFile = existingPiSessionPath(
      options.sessionDir,
      options.sessionId || '',
    );
    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, options.sessionDir, options.cwd)
      : SessionManager.create(options.cwd, options.sessionDir, {
          ...(options.sessionId ? { id: options.sessionId } : {}),
        });
    const customTools = (options.customTools ?? []) as ToolDefinition[];
    const toolAliases: Record<string, string> = {
      Bash: 'bash',
      Read: 'read',
      Write: 'write',
      Edit: 'edit',
      Glob: 'find',
      Grep: 'grep',
      Task: 'Agent',
      TaskOutput: 'get_subagent_result',
      TaskStop: 'steer_subagent',
    };
    const allowedNames = options.allowedTools ?? [];
    const selectedTools = options.allowedTools
      ? [
          ...new Set(
            allowedNames.flatMap((name) => {
              if (name === 'mcp__ckqclaw__*') {
                return customTools.map((tool) => tool.name);
              }
              return [toolAliases[name] || name];
            }),
          ),
        ].filter(
          (name) =>
            ['read', 'bash', 'edit', 'write', 'find', 'grep', 'ls'].includes(
              name,
            ) ||
            customTools.some((tool) => tool.name === name) ||
            ['Agent', 'get_subagent_result', 'steer_subagent'].includes(name) ||
            // External MCP names/patterns (`mcp__*`, `mcp__<server>__*`) are
            // resolved by Pi against the servers configured for this run.
            name.startsWith('mcp__'),
        )
      : undefined;
    const excludedTools = options.excludedTools?.map(
      (name) => toolAliases[name] || name,
    );

    const { session } = await createAgentSession({
      cwd: options.cwd,
      agentDir,
      modelRuntime,
      model: modelResolution.model,
      thinkingLevel:
        options.thinkingLevel === 'off' ? 'minimal' : options.thinkingLevel,
      ...(selectedTools ? { tools: selectedTools } : {}),
      ...(excludedTools ? { excludeTools: excludedTools } : {}),
      customTools,
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    // Pi 1.x does not bind extensions in createAgentSession: session_start
    // (which connects external MCP servers and arms extension lifecycle
    // hooks) only fires from bindExtensions.
    await session.bindExtensions({});
    return new PiRuntimeSession(session, eventBus);
  }
}
