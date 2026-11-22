import type { Context } from 'hono';
import type { ZodError } from 'zod';

/**
 * ISSUE-12 波 7 单元 7.2：zod 400 校验失败响应样板收敛（33 处 → 单点）。
 * 四分支逐字复刻既有四形状，不做语义归一（立项拍板②）：
 * - 'request-format'（A，9 处）：'Invalid request' + error.format()；
 * - 'body-format'（B，15 处）：'Invalid request body' + error.format()；
 * - 'request-issues'（C，2 处）：'Invalid request' + error.issues；
 * - 'body-plain'（D，7 处）：'Invalid request body'，无 details。
 * groups.ts 群创建的 E 形状（独立 code + field_errors 扁平化）保留独立实现，
 * 不进本 helper——那是面向前端字段级提示的专用契约。
 */
export type ZodBadRequestStyle =
  | 'request-format'
  | 'body-format'
  | 'request-issues'
  | 'body-plain';

export function zodBadRequest(
  c: Context,
  failure: ZodError,
  style: ZodBadRequestStyle,
): Response {
  switch (style) {
    case 'request-format':
      return c.json(
        { error: 'Invalid request', details: failure.format() },
        400,
      );
    case 'body-format':
      return c.json(
        { error: 'Invalid request body', details: failure.format() },
        400,
      );
    case 'request-issues':
      return c.json({ error: 'Invalid request', details: failure.issues }, 400);
    case 'body-plain':
      return c.json({ error: 'Invalid request body' }, 400);
  }
}
