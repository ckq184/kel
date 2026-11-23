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
 * ② Claude 上下文审计快照（ClaudeContext* 系列，宿主构造后经
 * `recordRunContextSnapshot` 直记，不再上事件流）→ ③ `StreamEvent`
 * 统一信封（所有运行时事件跨 Runner/Host/Web 三侧流转的载体）。
 */

/**
 * 事件类型词汇表，按簇分组：
 * - 流式内容：`text_delta` / `thinking_delta`
 * - 工具生命周期：`tool_use_start` / `tool_use_end` / `tool_progress`
 * - 子代理任务：`task_progress`
 * - 上下文：`compact_boundary` / `raw_sdk_event`
 * - 杂项：`usage` / `status`
 */
export type StreamEventType =
  | 'text_delta'
  | 'thinking_delta'
  | 'tool_use_start'
  | 'tool_use_end'
  | 'tool_progress'
  | 'task_progress'
  | 'compact_boundary'
  | 'raw_sdk_event'
  | 'usage'
  | 'status';

/** 事件产生者的运行时角色：主对话 / 后台任务 / 子代理 / 系统自身。 */
export type StreamAgentScope = 'main' | 'task' | 'subagent' | 'system';
/** 前端展示层级：primary 内联展示，detail 进轨迹面板，debug 仅开发者轨迹。 */
export type StreamDisplayLevel = 'primary' | 'detail' | 'debug';

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

/** 一次运行的 Claude 上下文装配总审计（宿主构造后经
 * `recordRunContextSnapshot` 直记快照，供预览接口读取）。 */
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
  /** 触发的技能名称。 */
  skillName?: string;
  /** 工具入参摘要。 */
  toolInputSummary?: string;
  /** Tool execution result text (truncated + sanitized), carried on
   *  `tool_result` events so the card/Web can surface what a tool returned,
   *  aligning the trace with what Claude Code shows. */
  toolResult?: string;
  /** Tool execution ended in error (carried on `tool_use_end`): cards/Web
   *  render the failure lane instead of a success ✅ (ISSUE-03). */
  isError?: boolean;
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
  /** 子代理类型标识。 */
  subagentType?: string;
  /** 工具完整入参。 */
  toolInput?: Record<string, unknown>;
  /** Token usage data emitted at query completion */
  usage?: {
    /** Stable logical run ID used to make usage analytics idempotent. */
    eventId?: string;
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
