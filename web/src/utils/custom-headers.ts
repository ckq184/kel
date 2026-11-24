/**
 * ISSUE-24：供应商表单「自定义请求头」行编辑器与 customEnv 的互转。
 *
 * 存储不变：仍是 customEnv.ANTHROPIC_CUSTOM_HEADERS，按 Claude Code 约定
 * 每行一个 `Name: Value`（runner 解析见 ISSUE-18 的 parseCustomHeaders）。
 * 用户拍板：
 * - 校验与 runner 同规则（头名 RFC 9110 token、值非空、值不含除 Tab 外的
 *   控制字符），不合格拒绝保存；头名大小写不敏感重名也拒绝；
 * - 旧值里解析不了的行整行放进头名格、值留空，由保存校验拦住让用户修；
 * - 错误提示只写序号和原因，不回显值。
 */

export const CUSTOM_HEADERS_ENV_KEY = 'ANTHROPIC_CUSTOM_HEADERS';

export interface HeaderRow {
  name: string;
  value: string;
}

// 与 container/agent-runner/src/runtime/pi/pi-provider.ts 保持一致。
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE_INVALID_RE = /[\u0000-\u0008\u000a-\u001f\u007f]/;

export function parseCustomHeaderRows(raw: string | undefined): HeaderRow[] {
  if (!raw) return [];
  const rows: HeaderRow[] = [];
  for (const text of raw.split(/\r\n|\r|\n/)) {
    if (!text.trim()) continue;
    const colon = text.indexOf(':');
    if (colon < 0) {
      rows.push({ name: text.trim(), value: '' });
      continue;
    }
    rows.push({
      name: text.slice(0, colon).trim(),
      value: text.slice(colon + 1).trim(),
    });
  }
  return rows;
}

export function buildCustomHeadersValue(rows: HeaderRow[]): {
  value: string;
  error: string | null;
} {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const [idx, row] of rows.entries()) {
    const name = row.name.trim();
    const value = row.value.trim();
    if (!name && !value) continue;
    const label = `第 ${idx + 1} 个请求头`;
    if (!name || !value) {
      return { value: '', error: `${label}的名称和值都要填写` };
    }
    if (!HEADER_NAME_RE.test(name)) {
      return {
        value: '',
        error: `${label}名称格式无效（仅允许字母、数字和 !#$%&'*+-.^_\`|~）`,
      };
    }
    if (HEADER_VALUE_INVALID_RE.test(value)) {
      return { value: '', error: `${label}的值不能包含换行等控制字符` };
    }
    const lower = name.toLowerCase();
    if (seen.has(lower)) {
      return { value: '', error: `请求头 "${name}" 重复` };
    }
    seen.add(lower);
    lines.push(`${name}: ${value}`);
  }
  return { value: lines.join('\n'), error: null };
}

/** 加载：把请求头键从 customEnv 里剔除并拆成行。 */
export function extractCustomHeaders(customEnv: Record<string, string>): {
  customEnv: Record<string, string>;
  headerRows: HeaderRow[];
} {
  const { [CUSTOM_HEADERS_ENV_KEY]: raw, ...rest } = customEnv;
  return { customEnv: rest, headerRows: parseCustomHeaderRows(raw) };
}

/** 保存：校验请求头行并写回 customEnv；没有请求头时不写该键。 */
export function applyCustomHeaders(
  customEnv: Record<string, string>,
  rows: HeaderRow[],
): { customEnv: Record<string, string>; error: string | null } {
  const result = buildCustomHeadersValue(rows);
  if (result.error) return { customEnv: {}, error: result.error };
  return {
    customEnv: result.value
      ? { ...customEnv, [CUSTOM_HEADERS_ENV_KEY]: result.value }
      : { ...customEnv },
    error: null,
  };
}
