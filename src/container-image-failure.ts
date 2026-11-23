/**
 * Container 镜像不可用（不存在 / 拉取被拒）的识别与告知（ISSUE-20）。
 *
 * `docker run` 找不到本地镜像且拉取失败时以退出码 125 退出。这是确定性失败：
 * 指数退避重试只会延迟告知、浪费资源，因此主路径识别后立即停止并告知用户。
 *
 * 识别刻意收窄（用户拍板 1）：只认退出码 125 且 stderr 命中镜像不可用文案；
 * 挂载、参数错误等其他 125 仍走现有重试。
 */

/** 主路径失败处理按此前缀分类（风格同 `context_overflow:` 等确定性失败）。 */
export const CONTAINER_IMAGE_UNAVAILABLE_ERROR_PREFIX =
  'container_image_unavailable:';

/** 用户可见文案：只说原因和处理建议，不暴露镜像名与 Docker 原文（用户拍板 3a）。 */
export const CONTAINER_IMAGE_UNAVAILABLE_USER_NOTICE =
  '⚠️ Agent 运行环境（容器镜像）不可用，本次处理已停止（已跳过自动重试）。请联系管理员在「监控」页拉取镜像，或将工作区切换为宿主机模式后重试。';

const IMAGE_UNAVAILABLE_PATTERNS: RegExp[] = [
  /Unable to find image/i,
  /pull access denied/i,
  /manifest unknown/i,
  /repository does not exist/i,
  /repository \S+ not found/i,
];

export function isContainerImageUnavailableExit(
  exitLabel: string,
  stderr: string,
): boolean {
  if (exitLabel !== 'code 125') return false;
  return IMAGE_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(stderr));
}

/**
 * 截取 stderr 用于错误串：超长时保留首尾（用户拍板 5）。
 * 旧实现 `slice(-200)` 会截掉 Docker 报错开头的镜像名。
 */
export function summarizeStderr(stderr: string, edge = 200): string {
  if (stderr.length <= edge * 2) return stderr;
  return `${stderr.slice(0, edge)}…${stderr.slice(-edge)}`;
}

/** Container 模式非零退出的错误构造，作为 closeCtx.enrichError 注入。 */
export function buildContainerExitError(
  stderr: string,
  exitLabel: string,
): { result: string | null; error: string } {
  const base = `Container exited with ${exitLabel}: ${summarizeStderr(stderr)}`;
  return {
    result: null,
    error: isContainerImageUnavailableExit(exitLabel, stderr)
      ? `${CONTAINER_IMAGE_UNAVAILABLE_ERROR_PREFIX} ${base}`
      : base,
  };
}

/**
 * 启动期预检（用户拍板 4）：镜像缺失时只打告警日志，不阻塞启动、不自动拉取。
 * 查询失败一律视为缺失。返回镜像是否存在。
 */
export async function warnIfContainerImageMissing(opts: {
  image: string;
  getImageId: () => Promise<string | null>;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}): Promise<boolean> {
  let id: string | null = null;
  try {
    id = await opts.getImageId();
  } catch {
    id = null;
  }
  if (id) return true;
  opts.warn(
    { image: opts.image },
    'Agent container image not found locally — container-mode workspaces will fail ' +
      'until it is available. Pull it from the Monitor page (admin) or run ' +
      '`docker pull <image>`, or switch the workspaces to host mode.',
  );
  return false;
}
