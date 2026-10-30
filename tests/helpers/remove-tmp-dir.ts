import fs from 'node:fs';

/**
 * Windows-safe cleanup for suite-owned tmp dirs (afterAll).
 *
 * win32 下 better-sqlite3 等原生文件句柄若未关闭，`fs.rmSync` 会抛 EPERM
 * （`force` 只豁免 ENOENT），未捕获异常会把整个 suite 记为失败。约定：
 * 调用方把已知句柄的关闭回调（如 db 模块的 `closeDatabase()`、只读探针
 * 连接的 `close()`）按序传入，本 helper 先逐一执行，再用 Node 官方
 * `maxRetries`/`retryDelay` 线性退避兜底句柄延迟释放的瞬态占用
 * （rm 的 retry 选项仅在 `recursive: true` 下生效，覆盖 EPERM/EBUSY 等）。
 */
export function removeTmpDirRecursive(
  dir: string,
  closeHandles: ReadonlyArray<() => void> = [],
): void {
  for (const close of closeHandles) {
    try {
      close();
    } catch {
      // 连接已关闭时重复 close 会抛错；清理路径按已释放处理
    }
  }
  fs.rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
