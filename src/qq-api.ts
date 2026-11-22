/**
 * QQ Bot REST API 层（原 src/qq.ts createQQConnection 工厂内“REST API”段
 * qq.ts:505-588 与模块级 QQApiError 类 qq.ts:75-83，ISSUE-12 单元 2.12 原文
 * 搬运）。
 *
 * 职责：
 *   - apiRequest：QQBot token 注入 + JSON 收发 + 响应体 2MB 上限 + 30s 超时
 *     + 错误归一（QQApiError，bizCode 提取）；
 *   - getGatewayUrl：/gateway/bot 拉取 + validateQQGatewayUrl 门校验。
 *
 * 依赖注入（闭包依赖显式参数化，feishu 系列同款机械替换）：
 *   - tokens.getAccessToken：2.11 createQQTokenManager 返回面的结构子集；
 *   - validateQQGatewayUrl：getGatewayUrl 的唯一依赖，是 src/qq.ts 的既有
 *     导出（外层门面约束“既有导出不动”），留在原文件；本模块不回环 import
 *     原文件（feishu 十模块零 child→parent 回环先例），故经同名参数注入，
 *     搬运体内 `validateQQGatewayUrl(data.url)` 逐字节不变。
 *
 * QQApiError 归属（grep 全部 throw/catch 消费点核实）：throw ×2 全在
 * apiRequest（本模块）；instanceof ×2 在 qq.ts 的 qqUploadPartFinish /
 * qqPartFinishPersistentRetry（2.13 素材，下一单元随段搬至 qq-media）。
 * 类随唯一 throw 侧安家本模块并导出，qq.ts 留守 catch 经 import 引用同一
 * 类身份（2.11 的 QQ_MAX_JSON_RESPONSE_BYTES 同款回接，instanceof 单一
 * 定义不变）。
 *
 * 常量随块迁移：QQ_API_BASE / QQ_API_REQUEST_TIMEOUT_MS 仅 apiRequest
 * 消费；QQ_MAX_JSON_RESPONSE_BYTES 与 qq-token 的 refreshToken 共享
 * （2.11 已随 token 段安家 qq-token.ts 并导出），本模块 import。
 */
import https from 'node:https';
import { QQ_MAX_JSON_RESPONSE_BYTES } from './qq-token.js';

const QQ_API_BASE = 'https://api.sgroup.qq.com';
const QQ_API_REQUEST_TIMEOUT_MS = 30_000;

export class QQApiError extends Error {
  constructor(
    message: string,
    public readonly bizCode?: number,
  ) {
    super(message);
    this.name = 'QQApiError';
  }
}

// src/qq.ts 的 createQQTokenManager 返回面的结构子集——仅收 apiRequest
// 实际消费的 getAccessToken；完整 tokenManager 经结构化类型自然满足。
export interface QQApiTokens {
  getAccessToken: () => Promise<string>;
}

export function createQQApi(
  tokens: QQApiTokens,
  validateQQGatewayUrl: (value: string) => string,
) {
  const { getAccessToken } = tokens;

  async function apiRequest<T = any>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const token = await getAccessToken();
    const url = new URL(path, QQ_API_BASE);
    const bodyStr = body ? JSON.stringify(body) : undefined;

    return new Promise<T>((resolve, reject) => {
      const req = https.request(
        {
          hostname: url.hostname,
          path: url.pathname + url.search,
          method,
          headers: {
            Authorization: `QQBot ${token}`,
            'Content-Type': 'application/json',
            ...(bodyStr
              ? { 'Content-Length': String(Buffer.byteLength(bodyStr)) }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let responseBytes = 0;
          res.on('data', (chunk: Buffer) => {
            responseBytes += chunk.length;
            if (responseBytes > QQ_MAX_JSON_RESPONSE_BYTES) {
              res.destroy(new Error('QQ API response is too large'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            try {
              const data = JSON.parse(text);
              if (res.statusCode && res.statusCode >= 400) {
                const errMsg = data.message || data.msg || text;
                const bizCode =
                  typeof data.code === 'number' ? data.code : undefined;
                reject(
                  new QQApiError(
                    `QQ API ${method} ${path} failed (${res.statusCode}): ${errMsg}`,
                    bizCode,
                  ),
                );
                return;
              }
              resolve(data as T);
            } catch {
              if (res.statusCode && res.statusCode >= 400) {
                reject(
                  new QQApiError(
                    `QQ API ${method} ${path} failed (${res.statusCode}): ${text}`,
                  ),
                );
              } else {
                // Some endpoints return empty body on success
                resolve({} as T);
              }
            }
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.setTimeout(QQ_API_REQUEST_TIMEOUT_MS, () => {
        req.destroy(new Error(`QQ API ${method} ${path} timed out`));
      });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  async function getGatewayUrl(): Promise<string> {
    const data = await apiRequest<{ url: string }>('GET', '/gateway/bot');
    if (!data.url) throw new Error('QQ gateway response did not include url');
    return validateQQGatewayUrl(data.url);
  }

  return {
    apiRequest,
    getGatewayUrl,
  };
}
