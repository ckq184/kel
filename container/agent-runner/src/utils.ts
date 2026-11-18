/**
 * Utility functions for CKQClaw Agent Runner.
 *
 * Pure utility functions with no side effects or state dependencies.
 */

/**
 * Shorten a string to maxLen, appending "..." if truncated.
 */
export function shorten(input: string, maxLen = 180): string {
  if (input.length <= maxLen) return input;
  return `${input.slice(0, maxLen)}...`;
}

/**
 * Recursively redact sensitive fields (tokens, passwords, API keys, etc.)
 * from an object. Limits recursion depth to 3 levels.
 */
export function redactSensitive(input: unknown, depth = 0): unknown {
  if (depth > 3) return '[truncated]';
  if (input == null) return input;
  if (
    typeof input === 'string' ||
    typeof input === 'number' ||
    typeof input === 'boolean'
  ) {
    return input;
  }
  if (Array.isArray(input)) {
    return input.slice(0, 10).map((item) => redactSensitive(item, depth + 1));
  }
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (
        /(token|password|secret|api[_-]?key|authorization|cookie)/iu.test(k)
      ) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactSensitive(v, depth + 1);
      }
    }
    return out;
  }
  return '[unsupported]';
}

/**
 * Strip well-known secret patterns embedded inside tool input strings before
 * they ride out as `toolInputSummary` to every connected WebSocket client and
 * the persisted stream-event log.
 *
 * `redactSensitive` only matches sensitive *keys* — that's not enough for
 * Bash/curl/WebFetch where the actual command/url string carries a Bearer
 * token, api_key=, sk-…, ghp_…, etc. as inline content. We string-replace
 * those before truncating to 180 chars.
 */
export function redactInlineSecrets(value: string): string {
  // 长度兜底：超过 32KB 直接整段标记，跳过昂贵的多 regex 扫描。攻击者
  // 若用 prompt-injection 让 agent 跑出 60KB+ 的 toolInput（接近 schema
  // 上限），原 regex 在 lazy-prefix 下退化为 O(n^2)（10k char ≈ 16ms,
  // 60k ≈ 600ms），可被多次链式 tool-call 钉住单 agent CPU。
  if (value.length > 32 * 1024) {
    return '[REDACTED LARGE INPUT]';
  }
  return (
    value
      // OAuth bearer (case-insensitive)
      .replace(/\bbearer\s+[A-Za-z0-9._\-+/=]{8,}/gi, 'Bearer [REDACTED]')
      // basic auth in URLs (https://user:pass@host) — extend beyond http(s)
      // to cover postgres / mongodb / redis / mysql / ftp / ssh / git etc.
      // The DSN form `<scheme>://user:pass@host/...` is universal; restrict
      // the scheme to a reasonable identifier shape to avoid colon-rich text.
      .replace(
        /(\b[a-z][a-z0-9+.\-]{1,15}:\/\/[^\s\/:@]+:)[^\s@\/?#]+(@)/gi,
        '$1[REDACTED]$2',
      )
      // key=value / key:value with explicit secret-shaped key. Anchor 不再
      // 用 lazy `[A-Za-z0-9_]*?` 兜底（O(n^2) ReDoS 源头），改成显式枚举
      // 常见前缀 + 限定长度。截止字符增加 ; , 拦多 cookie 行。
      .replace(
        /(?:^|[^A-Za-z0-9])((?:gh|github|gitlab|npm|access|refresh|auth|api)[_-]token|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|x-api-key|authorization|password|secret|cookie|token|pat)\s*[:=]\s*["']?[^"'\s;,&]+/giu,
        (m, k) => {
          const prefix = m.startsWith(k) ? '' : m[0];
          return `${prefix}${k}=[REDACTED]`;
        },
      )
      // CLI 形态 `--token <value>` / `--api-key value` / `-H 'Authorization: …'`
      .replace(
        /(--?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|x-api-key))\s+(?!--)\S{4,}/gi,
        '$1 [REDACTED]',
      )
      // 主流厂商 token 前缀
      .replace(/\bsk-(?:ant-)?[A-Za-z0-9_\-]{16,}/g, '[REDACTED]')
      .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '[REDACTED]')
      .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED]')
      .replace(/\bglpat-[A-Za-z0-9_\-]{20,}/g, '[REDACTED]')
      .replace(/\bxox[abeprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]')
      .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{12,20}\b/g, '[REDACTED]')
      .replace(/\bAIza[0-9A-Za-z_\-]{35}/g, '[REDACTED]')
      .replace(/\bsk_(?:live|test)_[A-Za-z0-9]{16,}/g, '[REDACTED]')
      .replace(/\bSG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}/g, '[REDACTED]')
      .replace(/\bnpm_[A-Za-z0-9]{30,}/g, '[REDACTED]')
      // private key / pem 头标识，整段一路擦到 END 标记
      .replace(
        /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
        '[REDACTED PRIVATE KEY]',
      )
  );
}

/**
 * One-line, redacted description of a tool call's input for the UI timeline
 * (`toolInputSummary`). Prefers a single well-known field; falls back to the
 * key-redacted JSON. Returns undefined while streamed arguments are still empty.
 */
export function summarizeToolInput(input: unknown): string | undefined {
  if (input == null) return undefined;

  if (typeof input === 'string') {
    return shorten(redactInlineSecrets(input.trim()));
  }

  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const keyCandidates = [
      'command',
      'query',
      'path',
      'pattern',
      'prompt',
      'url',
      'name',
    ];
    for (const key of keyCandidates) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim()) {
        return `${key}: ${shorten(redactInlineSecrets(value.trim()))}`;
      }
    }
    try {
      const json = JSON.stringify(redactSensitive(obj));
      // Skip empty or trivial objects (e.g. {} at content_block_start)
      if (!json || json === '{}' || json === '[]') return undefined;
      return shorten(redactInlineSecrets(json));
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/** Extract the text of a tool result: a string, content blocks, or Pi's `{ content: [...] }`. */
function toolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object') {
          const block = b as { type?: string; text?: string };
          if (block.type === 'text') return block.text ?? '';
          if (block.type === 'image') return '[image]';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    // Pi's AgentToolResult: { content: (TextContent | ImageContent)[], details }
    const inner = (content as { content?: unknown }).content;
    if (Array.isArray(inner)) return toolResultText(inner);
  }
  return undefined;
}

/** Only the head of a result is ever shown, so only the head is scanned for secrets. */
const RESULT_PREVIEW_CHARS = 8 * 1024;

/**
 * Bounded, redacted preview of a tool result for the stream (`toolResult` /
 * `detail`). The head is redacted before truncating so a secret near the cut
 * is never shown half-masked; scanning a bounded head (rather than the whole
 * result) keeps redactInlineSecrets' 32KB short-circuit from replacing a large
 * but harmless result with a placeholder.
 */
export function summarizeToolResult(
  content: unknown,
  maxLen = 400,
): string | undefined {
  const trimmed = toolResultText(content)?.trim();
  if (!trimmed) return undefined;
  const head =
    trimmed.length > RESULT_PREVIEW_CHARS
      ? trimmed.slice(0, RESULT_PREVIEW_CHARS)
      : trimmed;
  return shorten(redactInlineSecrets(head), maxLen);
}

/**
 * Pi has no Skill tool: a skill is activated when the model reads its
 * `SKILL.md`. Returns the skill (directory) name for a `read` of
 * `.../<skill>/SKILL.md`, else undefined. `toolName` is the Pi tool name.
 */
export function extractSkillName(
  toolName: unknown,
  input: unknown,
): string | undefined {
  if (toolName !== 'read') return undefined;
  if (!input || typeof input !== 'object') return undefined;
  const path = (input as Record<string, unknown>).path;
  if (typeof path !== 'string') return undefined;
  return path.match(/\/([^/]+)\/SKILL\.md$/)?.[1];
}

const STALE_BACKGROUND_WAIT_PATTERNS = [
  /等待其余\s*\d+\s*个\s*(?:Agent|agent|任务|后台任务)/u,
  /\d+\s*\/\s*\d+\s*完成[\s\S]{0,80}等待/u,
  /后台\s*(?:Agent|agent|任务)[\s\S]{0,80}(?:完成后|结束后)[\s\S]{0,80}(?:继续汇总|自动唤醒|继续)/u,
  /(?:任务|Agent|agent)[\s\S]{0,80}(?:运行中|还在跑|尚未完成)[\s\S]{0,80}(?:继续汇总|等待)/u,
  /(?:I'll|I will)\s+wait\s+for\s+the\s+(?:other|remaining)\s+\d+\s+(?:agents|tasks)/iu,
  /(?:waiting|wait)\s+for\s+(?:the\s+)?(?:other|remaining)\s+\d+\s+(?:agents|tasks)/iu,
];

/**
 * Background task completion can race with model text generation. The SDK may
 * deliver all task notifications, but the model can still finish with a stale
 * progress update ("1/6 done, waiting for the rest"). Only use this predicate
 * after this query has already emitted a result with pending background tasks.
 */
export function isStaleBackgroundWaitReply(
  text: string | null | undefined,
): boolean {
  const trimmed = text?.trim();
  if (!trimmed) return false;
  return STALE_BACKGROUND_WAIT_PATTERNS.some((pattern) =>
    pattern.test(trimmed),
  );
}

/**
 * 解析当前时区名（IANA）。与主服务 src/config.ts 的 TIMEZONE 同一条 fallback 链
 * （agent-runner 是独立项目，无法 import src/，故在此复刻）。容器模式下 entrypoint
 * 注入了 TZ；host 模式可能没设 TZ，退回系统解析的时区，最后兜底 Asia/Shanghai。
 */
export function currentTimeZone(): string {
  return (
    process.env.TZ ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'Asia/Shanghai'
  );
}

interface LocalParts {
  date: string; // YYYY-MM-DD
  time: string; // HH:mm:ss
  offset: string; // +08:00 / -05:00 / +00:00
}

function localDateTimeParts(d: Date, tz: string): LocalParts {
  const dtParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => dtParts.find((p) => p.type === t)?.value ?? '';
  // en-CA + hour12:false 在午夜可能给出 '24'，归一到 '00'。
  let hour = get('hour');
  if (hour === '24') hour = '00';

  const offsetParts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'longOffset',
  }).formatToParts(d);
  const offsetName =
    offsetParts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  const m = offsetName.match(/GMT([+-]\d{2}:?\d{2})/);
  let offset = m ? m[1] : '+00:00';
  if (offset.length === 5) offset = `${offset.slice(0, 3)}:${offset.slice(3)}`; // +0800 -> +08:00

  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${hour}:${get('minute')}:${get('second')}`,
    offset,
  };
}

/**
 * 把一个 UTC ISO 串（如存储层的 next_run）转成本地时区的可读串，供回执/列表展示。
 * 形如：2026-06-12 10:50:00 (+08:00)。空/非法输入分别返回 'N/A' / 原样。
 */
export function formatIsoLocal(iso: string | null | undefined): string {
  if (!iso) return 'N/A';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const tz = currentTimeZone();
  const { date, time, offset } = localDateTimeParts(d, tz);
  return `${date} ${time} (${offset})`;
}
