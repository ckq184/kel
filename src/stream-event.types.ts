/**
 * Canonical StreamEvent type definitions.
 *
 * This is the single source of truth. Build step copies this file to:
 *   - container/agent-runner/src/stream-event.types.ts
 *   - src/stream-event.types.ts
 *   - web/src/stream-event.types.ts
 *
 * DO NOT edit the copies directly -- edit this file and run `make build`.
 */

/**
 * 文件结构导览：① 事件类型词汇表（StreamEventType 联合类型）→
 * ② Claude 上下文审计快照（ClaudeContext* 系列，随 `context_audit`
 * 事件上报）→ ③ `StreamEvent` 统一信封（所有运行时事件跨
 * Runner/Host/Web 三侧流转的载体）。
 */

/**
 * 事件类型词汇表，按簇分组：
 * - 流式内容：`text_delta` / `thinking_delta`
 * - 工具生命周期：`tool_use_start` / `tool_use_end` / `tool_progress` / `tool_result`
 * - Hook 执行：`hook_started` / `hook_progress` / `hook_response`
 * - SDK 任务（后台任务/子代理/动态工作流）：`task_start` / `task_progress` /
 *   `task_updated` / `task_notification`
 * - 上下文与权限：`permission_denied` / `memory_recall` / `compact_boundary` /
 *   `context_audit` / `raw_sdk_event`
 * - 杂项：`notification` / `prompt_suggestion` / `todo_update` / `usage` /
 *   `status` / `init`
 */
export type StreamEventType =
  | 'text_delta'
  | 'thinking_delta'
  | 'tool_use_start'
  | 'tool_use_end'
  | 'tool_progress'
  | 'tool_result'
  | 'hook_started'
  | 'hook_progress'
  | 'hook_response'
  | 'task_start'
  | 'task_progress'
  | 'task_updated'
  | 'task_notification'
  | 'permission_denied'
  | 'memory_recall'
  | 'compact_boundary'
  | 'notification'
  | 'prompt_suggestion'
  | 'raw_sdk_event'
  | 'context_audit'
  | 'todo_update'
  | 'usage'
  | 'status'
  | 'init';

/** 事件产生者的运行时角色：主对话 / 后台任务 / 子代理 / 系统自身。 */
export type StreamAgentScope = 'main' | 'task' | 'subagent' | 'system';
/** 前端展示层级：primary 内联展示，detail 进轨迹面板，debug 仅开发者轨迹。 */
export type StreamDisplayLevel = 'primary' | 'detail' | 'debug';

/** 动态工作流单个阶段的快照（随 `workflowRun` 上报，供工作流卡片渲染）。 */
export interface WorkflowPhaseSnapshot {
  /** 阶段在整条工作流中的序号。 */
  index: number;
  /** 阶段标题。 */
  title: string;
  /** 阶段补充说明。 */
  detail?: string;
}

/** 动态工作流中单个子代理的实时快照。 */
export interface WorkflowAgentSnapshot {
  /** 快照列表中的序号。 */
  index: number;
  /** 子代理展示标签。 */
  label: string;
  /** 所属阶段序号。 */
  phaseIndex?: number;
  /** 所属阶段标题。 */
  phaseTitle?: string;
  /** 子代理运行 ID。 */
  agentId?: string;
  /** 当前使用的模型。 */
  model?: string;
  /** 降级回退模型。 */
  fallbackModel?: string;
  /** 生命周期状态。 */
  state: 'queued' | 'running' | 'done' | 'failed' | 'stopped' | 'unknown';
  /** 入队时间戳。 */
  queuedAt?: number;
  /** 启动时间戳。 */
  startedAt?: number;
  /** 完成时间戳。 */
  completedAt?: number;
  /** 尝试轮次。 */
  attempt?: number;
  /** 最近一次工具调用的名称。 */
  lastToolName?: string;
  /** 最近一次工具调用的摘要。 */
  lastToolSummary?: string;
  /** 提示词预览（截断）。 */
  promptPreview?: string;
  /** 结果预览（截断）。 */
  resultPreview?: string;
  /** 累计 token 数。 */
  tokens?: number;
  /** 累计工具调用次数。 */
  toolCalls?: number;
  /** 运行时长（毫秒）。 */
  durationMs?: number;
}

/** Persistable, user-facing projection of one Claude Code dynamic Workflow. */
export interface WorkflowRunSnapshot {
  /** 所属宿主任务的 ID。 */
  taskId: string;
  /** 本次工作流运行的 ID。 */
  runId?: string;
  /** 工作流 meta.name（仅动态工作流任务携带）。 */
  workflowName?: string;
  /** 运行摘要。 */
  summary: string;
  /** 运行状态。 */
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'unknown';
  /** 开始时间戳。 */
  startTime?: number;
  /** 完成时间戳。 */
  completedAt?: number;
  /** 总时长（毫秒）。 */
  durationMs?: number;
  /** 子代理数量。 */
  agentCount?: number;
  /** 全部子代理累计 token 数。 */
  totalTokens?: number;
  /** 全部子代理累计工具调用次数。 */
  totalToolCalls?: number;
  /** 阶段快照列表。 */
  phases: WorkflowPhaseSnapshot[];
  /** 子代理快照列表。 */
  agents: WorkflowAgentSnapshot[];
}

/** 单个 Claude 上下文文件（如 CLAUDE.md / 记忆文件）的审计快照。 */
export interface ClaudeContextFileAudit {
  /** 源头路径（宿主/仓库侧）。 */
  sourcePath?: string;
  /** 运行时实际生效路径（容器/运行目录侧）。 */
  runtimePath?: string;
  /** 装配状态：linked=已链接，mounted=已挂载，missing=缺失，
   *  shadowed=被遮蔽，unavailable=不可用，unknown=未知。 */
  status:
    | 'linked'
    | 'mounted'
    | 'missing'
    | 'shadowed'
    | 'unavailable'
    | 'unknown';
  /** token 占用估算。 */
  tokens?: number;
  /** 是否实际载入了上下文。 */
  loaded?: boolean;
}

/** Claude 规则目录（rules）的审计快照。 */
export interface ClaudeContextRulesAudit {
  /** 源头路径（宿主/仓库侧）。 */
  sourcePath?: string;
  /** 运行时实际生效路径。 */
  runtimePath?: string;
  /** 装配状态。 */
  status: 'linked' | 'mounted' | 'missing' | 'unavailable' | 'unknown';
  /** 发现的规则文件总数。 */
  fileCount: number;
  /** 实际载入的文件数。 */
  loadedFileCount?: number;
  /** 实际载入的文件清单（含各自 token 估算）。 */
  loadedFiles?: Array<{ path: string; tokens?: number }>;
}

/** 单个技能来源的审计快照。 */
export interface ClaudeContextSkillsSourceAudit {
  /** 来源类别：builtin=内置，external=外部，project=项目，managed=托管，
   *  workspace=工作区，user=用户，unknown=未知。 */
  name:
    | 'builtin'
    | 'external'
    | 'project'
    | 'managed'
    | 'workspace'
    | 'user'
    | 'unknown';
  /** 源头路径（宿主/仓库侧）。 */
  sourcePath?: string;
  /** 运行时实际生效路径。 */
  runtimePath?: string;
  /** 该来源的技能数量。 */
  count?: number;
  /** 该来源的 token 占用估算。 */
  tokens?: number;
}

/** 技能装配的整体审计。 */
export interface ClaudeContextSkillsAudit {
  /** 发现的技能总数。 */
  totalSkills?: number;
  /** 实际纳入上下文的技能数。 */
  includedSkills?: number;
  /** 技能占用的 token 估算。 */
  tokens?: number;
  /** 技能清单哈希。 */
  manifestHash?: string;
  /** 本轮实际选中的技能 ID。 */
  selectedSkillIds?: string[];
  /** 各来源明细。 */
  sources: ClaudeContextSkillsSourceAudit[];
}

/** CKQClaw 平台提示词（prompt plan）的装配审计。 */
export interface ClaudeContextPromptAudit {
  /** 提示词总字节数。 */
  totalBytes: number;
  /** token 占用估算。 */
  estimatedTokens?: number;
  /** 提示词计划哈希。 */
  planHash?: string;
  /** 回合锚点截断审计：原始字符数、锚定保留字符数与是否截断。 */
  turnAnchor?: {
    provider: 'custom';
    maxChars: number;
    sourceChars: number;
    anchoredChars: number;
    truncated: boolean;
    estimatedTokens: number;
  };
  files: Array<{
    /** 提示词文件名。 */
    name: string;
    /** 文件字节数。 */
    bytes: number;
    /** 提示词文件 ID。 */
    id?: string;
    /** 提示词文件版本。 */
    version?: number;
    /** 生效范围：main=主代理，subagent=子代理，both=两者。 */
    scope?: 'main' | 'subagent' | 'both';
    /** 归属：platform=平台，agent_profile=智能体档案，workspace=工作区，channel=渠道。 */
    owner?: 'platform' | 'agent_profile' | 'workspace' | 'channel';
    /** 是否必需（缺失即装配失败）。 */
    required?: boolean;
    /** 装配条件。 */
    condition?: string;
    /** 内容哈希。 */
    hash?: string;
    /** token 占用估算。 */
    estimatedTokens?: number;
  }>;
}

/** SDK 上下文用量审计：分类 token 占用与可视化网格数据。 */
export interface ClaudeSdkContextUsageAudit {
  /** 分类占用明细（名称 / token / 展示颜色）。 */
  categories: Array<{
    name: string;
    tokens: number;
    color: string;
    /** 是否延后载入（未实际占用当前窗口）。 */
    isDeferred?: boolean;
  }>;
  /** 已用 token 总数。 */
  totalTokens: number;
  /** 上下文窗口上限。 */
  maxTokens: number;
  /** 模型原始（未打折）窗口上限。 */
  rawMaxTokens: number;
  /** 已用占比（0–100）。 */
  percentage: number;
  gridRows: Array<
    Array<{
      color: string;
      isFilled: boolean;
      categoryName: string;
      tokens: number;
      percentage: number;
      squareFullness: number;
    }>
  >;
  /** 本次运行使用的模型名。 */
  model: string;
  /** 记忆文件占用明细。 */
  memoryFiles: Array<{ path: string; type: string; tokens: number }>;
  /** MCP 工具占用明细。 */
  mcpTools: Array<{
    name: string;
    serverName: string;
    tokens: number;
    /** 是否已实际载入上下文。 */
    isLoaded?: boolean;
  }>;
  /** 延迟载入的内置工具及其 token 估算。 */
  deferredBuiltinTools?: Array<{
    name: string;
    tokens: number;
    isLoaded: boolean;
  }>;
  /** 系统内置工具占用。 */
  systemTools?: Array<{ name: string; tokens: number }>;
  /** 系统提示词各分节占用。 */
  systemPromptSections?: Array<{ name: string; tokens: number }>;
  /** 子代理定义占用（类型 + 来源）。 */
  agents: Array<{ agentType: string; source: string; tokens: number }>;
  /** 斜杠命令的数量与占用。 */
  slashCommands?: {
    totalCommands: number;
    includedCommands: number;
    tokens: number;
  };
  /** 技能数量与占用（含 frontmatter 明细）。 */
  skills?: {
    totalSkills: number;
    includedSkills: number;
    tokens: number;
    skillFrontmatter: Array<{
      name: string;
      source: string;
      tokens: number;
    }>;
  };
  /** 自动压缩触发阈值。 */
  autoCompactThreshold?: number;
  /** 是否启用自动压缩。 */
  isAutoCompactEnabled: boolean;
  /** 按消息构成的细分占用（工具调用/结果、附件、助手/用户消息等）。 */
  messageBreakdown?: {
    toolCallTokens: number;
    toolResultTokens: number;
    attachmentTokens: number;
    assistantMessageTokens: number;
    userMessageTokens: number;
    redirectedContextTokens: number;
    unattributedTokens: number;
    toolCallsByType: Array<{
      name: string;
      callTokens: number;
      resultTokens: number;
    }>;
    attachmentsByType: Array<{ name: string; tokens: number }>;
  };
  /** SDK 原始 API 用量（输入/输出/缓存写入/缓存读取）。 */
  apiUsage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  } | null;
}

/** 一次运行的 Claude 上下文装配总审计（随 `context_audit` 事件上报）。 */
export interface ClaudeContextAudit {
  /** 执行环境：宿主或容器。 */
  executionMode: 'host' | 'container';
  /** 命中的智能体档案及其身份/运行时策略哈希。 */
  agentProfile?: {
    id: string;
    version: number;
    identityHash: string;
    runtimePolicyHash?: string;
  };
  /** 工作目录。 */
  cwd?: string;
  /** CKQClaw repository root used to distinguish platform memory from workspace memory. */
  projectRoot?: string;
  /** Claude 配置目录（CLAUDE_CONFIG_DIR）。 */
  claudeConfigDir?: string;
  /** 外部 Claude 数据目录。 */
  externalClaudeDir?: string;
  /** SDK memory exclusion patterns applied for this run. */
  claudeMdExcludes?: string[];
  /** CLAUDE.md 记忆文件审计。 */
  claudeMd: ClaudeContextFileAudit;
  /** 规则目录审计。 */
  rules: ClaudeContextRulesAudit;
  nativeConfig?: {
    enabled: boolean;
    settingSources: Array<'user' | 'project' | 'local'>;
    entries: Array<{
      name: string;
      kind: 'file' | 'directory' | 'settings';
      sourcePath?: string;
      runtimePath?: string;
      status: 'linked' | 'mounted' | 'merged' | 'missing' | 'unavailable';
      entryCount?: number;
    }>;
  };
  /** 技能装配审计。 */
  skills: ClaudeContextSkillsAudit;
  /** MCP 清单哈希与本轮启用的服务 ID。 */
  mcp?: { manifestHash: string; serverIds: string[] };
  /** 平台提示词装配审计。 */
  ckqclawPrompt: ClaudeContextPromptAudit;
  /** SDK 上下文用量明细。 */
  sdkContextUsage?: ClaudeSdkContextUsageAudit;
  /** 上下文预算状态：ok/警告/硬超限及各阈值。 */
  contextBudget?: {
    status: 'unavailable' | 'ok' | 'warning' | 'hard_exceeded';
    startupTokens?: number;
    totalTokens?: number;
    maxTokens?: number;
    warningThreshold?: number;
    hardThreshold?: number;
    warning?: string;
    error?: string;
  };
  /** 子代理契约：启用状态、契约哈希与 SDK/CLI 兼容版本。 */
  subagentContract?: {
    enabled: boolean;
    hash: string;
    sdkCompatibility: string;
    cliCompatibility: string;
  };
  /** 装配警告列表。 */
  warnings: string[];
}

/**
 * 三侧流转的事件统一信封：Runner 产出 → Host 转发/持久化 → Web 渲染。
 * 除 `eventType` 外全部字段可选，各字段只在特定事件类型上有意义。
 */
export interface StreamEvent {
  /** 事件类型，见 `StreamEventType` 分簇说明。 */
  eventType: StreamEventType;
  /** Which runtime actor produced the event. */
  agentScope?: StreamAgentScope;
  /** Exact GroupQueue query attempt that produced this event. */
  queryRunId?: string;
  /** Correlates all stream events for a single user turn. */
  turnId?: string;
  /** SDK session identifier if known. */
  sessionId?: string;
  /** SDK message uuid if known. */
  messageUuid?: string;
  /** Reserved — whether this event was synthesized locally rather than emitted directly by SDK semantics. */
  isSynthetic?: boolean;
  /** UI priority: primary is surfaced inline, detail in trace panels, debug in developer trace. */
  displayLevel?: StreamDisplayLevel;
  /** 文本载荷（流式增量或通知正文）。 */
  text?: string;
  /** 标题（卡片/通知用）。 */
  title?: string;
  /** 摘要。 */
  summary?: string;
  /** 补充详情。 */
  detail?: string;
  /** 原始 SDK 事件类型（如 `stream_event/message_start`），透传类事件携带。 */
  rawType?: string;
  /** 工具名称。 */
  toolName?: string;
  /** 本次工具调用的 ID。 */
  toolUseId?: string;
  /** 父工具调用 ID（嵌套工具调用时指向外层；缺省即顶层调用）。 */
  parentToolUseId?: string | null;
  /** 是否为嵌套（子代理内部）调用。 */
  isNested?: boolean;
  /** 触发的技能名称。 */
  skillName?: string;
  /** 工具入参摘要。 */
  toolInputSummary?: string;
  /** Tool execution result text (truncated + sanitized), carried on
   *  `tool_result` events so the card/Web can surface what a tool returned,
   *  aligning the trace with what Claude Code shows. */
  toolResult?: string;
  /** 已耗时（秒）。 */
  elapsedSeconds?: number;
  /** Hook 名称。 */
  hookName?: string;
  /** Hook 事件类型。 */
  hookEvent?: string;
  /** Hook 执行结果。 */
  hookOutcome?: string;
  /** 状态行文本。 */
  statusText?: string;
  /** SDK 任务描述。 */
  taskDescription?: string;
  /** SDK 任务 ID。 */
  taskId?: string;
  /** 任务状态。 */
  taskStatus?: string;
  /** 任务结果摘要。 */
  taskSummary?: string;
  /** SDK task discriminant, e.g. `local_workflow` or `subagent`. */
  taskType?: string;
  /** Claude Code Workflow meta.name (only present for workflow tasks). */
  workflowName?: string;
  /** Live/completed dynamic Workflow projection for first-class UI rendering. */
  workflowRun?: WorkflowRunSnapshot;
  /** SDK 任务字段的增量更新（状态/描述/结束时间/累计暂停时长/错误/后台标记）。 */
  taskPatch?: {
    status?: string;
    description?: string;
    end_time?: number;
    total_paused_ms?: number;
    error?: string;
    is_backgrounded?: boolean;
  };
  /** 子代理类型标识。 */
  subagentType?: string;
  /** 最近一次工具调用的名称（任务进度类事件携带）。 */
  lastToolName?: string;
  /** 保留字段：当前仓库内无产生方与消费方（2026-11-19 全仓 grep 取证）。 */
  outputFile?: string;
  /** SDK 任务的累计用量（token / 工具调用次数 / 时长）。 */
  sdkTaskUsage?: {
    totalTokens: number;
    toolUses: number;
    durationMs: number;
  };
  /** 权限拒绝详情：被拒工具、调用 ID、原因类型与说明。 */
  permissionDenied?: {
    toolName: string;
    toolUseId: string;
    agentId?: string;
    reasonType?: string;
    reason?: string;
    message: string;
  };
  /** 是否后台任务。 */
  isBackground?: boolean;
  /** 是否协作型（teammate）SDK 任务——前端据此跳过普通后台任务的 stale 计时等处理。 */
  isTeammate?: boolean;
  /** 工具完整入参。 */
  toolInput?: Record<string, unknown>;
  /** 原始 SDK 事件负载（透传，不做结构化保证）。 */
  rawEvent?: Record<string, unknown>;
  /** 上下文装配审计（`context_audit` 事件携带）。 */
  contextAudit?: ClaudeContextAudit;
  /** 任务清单快照（`todo_update` 事件携带）。 */
  todos?: Array<{
    id: string;
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
  }>;
  /** Token usage data emitted at query completion */
  usage?: {
    /** Stable logical run ID used to make usage analytics idempotent. */
    eventId?: string;
    /** Position inside one result's per-message ledger batch (0-based). */
    batchIndex?: number;
    /** 本批分片的分母（与 batchIndex 配合表达 N/M 中的 M）。 */
    batchCount?: number;
    /** 输入 token 数。 */
    inputTokens: number;
    /** 输出 token 数。 */
    outputTokens: number;
    /** 缓存读取命中的输入 token 数。 */
    cacheReadInputTokens: number;
    /** 缓存新写入的输入 token 数。 */
    cacheCreationInputTokens: number;
    /** 推理（thinking）token 数。 */
    reasoningTokens: number;
    /** 成本（美元）。 */
    costUSD: number;
    /** 本次查询耗时（毫秒）。 */
    durationMs: number;
    /** SDK 回合数。 */
    numTurns: number;
    /** 分模型的用量明细。 */
    modelUsage?: Record<
      string,
      {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
        reasoningTokens: number;
        costUSD: number;
      }
    >;
  };
}
