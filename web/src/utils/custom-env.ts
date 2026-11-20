/**
 * 自定义环境变量严格解析（ISSUE-11 B5，用户拍板 #7）。
 *
 * 原 ProviderEditor.tsx（宽松版：允许小写 key / 空 value / 不 trim）与
 * SetupProvidersPage.tsx（严格版）校验已分叉，收敛为「Setup 版校验 +
 * ProviderEditor 可选第三方默认键拦截」的严格合成版：
 * - 仅大写 key（/^[A-Z_][A-Z0-9_]*$/，不能数字开头）；
 * - key 与 value 都非空，存储 trim 后的值；
 * - 五个保留键拦截；options.manageThirdPartyDefaults 为真时额外拦截
 *   系统为第三方配置预填的默认键（buildDefaultProviderEnv 的 key 集）；
 * - 重复 key 检测；任一错误整包作废 {customEnv: {}, error}；
 * - 空行跳过（行号即错误提示中的「第 N 行」）。
 *
 * 输入为 KEY=value 逐行文本（按第一个 '=' 切分，右侧整体属于 value，
 * 与宿主侧 env 行解析约定一致）；EnvRow 行编辑器由调用方自行序列化。
 * ProviderEditor 的行为随之收紧：小写 key / 空 value 将被拒（拍板项，
 * 存量已存数据不动）。
 */
import { buildDefaultProviderEnv } from './provider-model';

export const RESERVED_ENV_KEYS = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_MODEL',
]);

export const DEFAULTED_THIRD_PARTY_ENV_KEYS = new Set(
  buildDefaultProviderEnv('', 'auto').map((row) => row.key),
);

export interface BuildCustomEnvOptions {
  manageThirdPartyDefaults?: boolean;
}

export interface BuildCustomEnvResult {
  customEnv: Record<string, string>;
  error: string | null;
}

export function buildCustomEnv(
  text: string,
  options?: BuildCustomEnvOptions,
): BuildCustomEnvResult {
  const customEnv: Record<string, string> = {};

  for (const [idx, rawLine] of text.split('\n').entries()) {
    const line = rawLine.trim();
    // 空行跳过（对应行编辑器中 key/value 均为空的占位行）。
    if (!line) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) {
      return {
        customEnv: {},
        error: `第 ${idx + 1} 行环境变量的 Key 和 Value 都要填写`,
      };
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();

    if (!key || !value) {
      return {
        customEnv: {},
        error: `第 ${idx + 1} 行环境变量的 Key 和 Value 都要填写`,
      };
    }
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      return {
        customEnv: {},
        error: `环境变量 Key "${key}" 格式无效（仅允许大写字母/数字/下划线，且不能数字开头）`,
      };
    }
    if (
      RESERVED_ENV_KEYS.has(key) ||
      (options?.manageThirdPartyDefaults &&
        DEFAULTED_THIRD_PARTY_ENV_KEYS.has(key))
    ) {
      // 文案取 ProviderEditor 版（交付记录已声明）：保留键与第三方默认
      // 键共用同一条提示，且「请直接修改对应值」对两处 UI 均成立。
      return {
        customEnv: {},
        error: `${key} 已在系统预填列表中，请直接修改对应值`,
      };
    }
    if (customEnv[key] !== undefined) {
      return { customEnv: {}, error: `环境变量 Key "${key}" 重复` };
    }
    customEnv[key] = value;
  }

  return { customEnv, error: null };
}
