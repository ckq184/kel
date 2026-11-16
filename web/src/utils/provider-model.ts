const ONE_MILLION_CONTEXT_SUFFIX_RE = /(?:\[1m\])+$/i;

/**
 * 任务AL：上下文窗口声明预设（与服务端 ContextWindowPreset 对齐）。
 * `auto` = 现行为（[1m] 后缀启发式 → 1M，否则 200k）。
 */
export type ContextWindowPreset = 'auto' | 128000 | 256000 | 512000 | 1000000;

export const CONTEXT_WINDOW_OPTIONS: readonly {
  value: ContextWindowPreset;
  label: string;
}[] = [
  { value: 'auto', label: '自动' },
  { value: 128000, label: '128K' },
  { value: 256000, label: '256K' },
  { value: 512000, label: '512K' },
  { value: 1000000, label: '1M' },
];

export interface ProviderModelSelection {
  model: string;
  oneMillionContext: boolean;
}

export interface DefaultProviderEnvRow {
  key: string;
  value: string;
  source: 'model' | 'context' | 'default';
}

/** Convert a stored provider model into the editable model name and context flag. */
export function parseProviderModel(value: string): ProviderModelSelection {
  const normalized = value.trim();
  const oneMillionContext = ONE_MILLION_CONTEXT_SUFFIX_RE.test(normalized);
  return {
    model: normalized.replace(ONE_MILLION_CONTEXT_SUFFIX_RE, '').trim(),
    oneMillionContext,
  };
}

/**
 * Build the model value sent to the API. 任务AL 起 [1m] 后缀不再随模型名上送
 * （宿主与 runner 均已剥离，第三方端点 400 根治）——只剥离，永不追加；
 * 窗口语义改由独立的 contextWindow 声明承载。
 */
export function buildProviderModel(value: string): string {
  return parseProviderModel(value).model;
}

/** 认定有效窗口：声明 > [1m] 启发式（存量兼容展示）> 200k，镜像宿主归一逻辑。 */
export function resolveProviderContextWindow(
  value: string,
  declared: ContextWindowPreset,
): number {
  if (declared !== 'auto') return declared;
  return parseProviderModel(value).oneMillionContext ? 1_000_000 : 200_000;
}

/** Build the editable defaults prefilled for third-party providers. */
export function buildDefaultProviderEnv(
  value: string,
  contextWindow: ContextWindowPreset,
): DefaultProviderEnvRow[] {
  const model = buildProviderModel(value);
  const contextWindowTokens = resolveProviderContextWindow(
    value,
    contextWindow,
  );
  return [
    { key: 'ANTHROPIC_DEFAULT_OPUS_MODEL', value: model, source: 'model' },
    { key: 'ANTHROPIC_DEFAULT_SONNET_MODEL', value: model, source: 'model' },
    { key: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', value: model, source: 'model' },
    {
      key: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
      value: String(contextWindowTokens),
      source: 'context',
    },
    {
      key: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      value: '1',
      source: 'default',
    },
    { key: 'CLAUDE_CODE_EFFORT_LEVEL', value: 'max', source: 'default' },
    { key: 'CLAUDE_CODE_NO_FLICKER', value: '1', source: 'default' },
    { key: 'API_TIMEOUT_MS', value: '3000000', source: 'default' },
  ];
}
