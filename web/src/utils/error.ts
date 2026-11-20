import type { ApiError } from '../api/client';

/**
 * Extract a human-readable message from an unknown catch value.
 *
 * ISSUE-11 B4 行为统一基准：Error.message 优先 → 对象 .message →
 * String(err)；原文保留不 trim。可选 fallback 由调用方传入，仅在提取
 * 结果为空（空串/空值）时生效；无 fallback 保持原有行为。
 */
export function extractErrorMessage(err: unknown, fallback?: string): string {
  let message: string;
  if (err instanceof Error) {
    message = err.message;
  } else if (typeof err === 'object' && err !== null && 'message' in err) {
    message = (err as ApiError).message;
  } else {
    message = String(err);
  }
  if (fallback !== undefined && !message) return fallback;
  return message;
}
