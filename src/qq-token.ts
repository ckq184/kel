/**
 * QQ Bot OAuth access token 管理（原 src/qq.ts createQQConnection 工厂内
 * “Token Management”段 qq.ts:505-599 与 Token state qq.ts:389-391，ISSUE-12
 * 单元 2.11 原文搬运）。
 *
 * 职责：
 *   - getAccessToken：缓存命中直返 + singleflight 复用在途刷新；
 *   - refreshToken：原生 https 直发 QQ_TOKEN_URL，响应体 2MB 上限、15s
 *     超时，expires_in 默认 7200s、提前 5min 失效缓冲。
 *
 * 闭包状态盘点（可变 let → 工厂内部状态，feishu 系列同款机械替换）：
 *   - tokenInfo：缓存 token。原 qq.ts 有两处外写（WS close 'refresh-token'
 *     分支与 disconnect() 的 `tokenInfo = null` 复位），状态内化后经
 *     resetToken() 等价承接——只清缓存、不动在途 tokenRefreshPromise。
 *   - tokenRefreshPromise：singleflight 在途 Promise，仅本工厂内部消费。
 *
 * 常量随块迁移：QQ_TOKEN_URL / TOKEN_REFRESH_BUFFER_MS /
 * QQ_TOKEN_REQUEST_TIMEOUT_MS 仅 token 簇使用；QQ_MAX_JSON_RESPONSE_BYTES
 * 同时被留在 src/qq.ts 的 apiRequest 消费，故由本模块导出、qq.ts import
 * （先例：feishu-media 的 FEISHU_RESOURCE_REQUEST_TIMEOUT_MS）。
 */
import https from 'node:https';
import { logger } from './logger.js';

const QQ_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const TOKEN_REFRESH_BUFFER_MS = 300_000; // refresh 5min before expiry
const QQ_TOKEN_REQUEST_TIMEOUT_MS = 15_000;
export const QQ_MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;

interface TokenInfo {
  accessToken: string;
  expiresAt: number;
}

// src/qq.ts 的 QQConnectionConfig 的结构子集——仅收 token 刷新实际消费的
// appId / appSecret；完整配置经结构化类型自然满足本接口。
interface QQTokenManagerConfig {
  appId: string;
  appSecret: string;
}

export function createQQTokenManager(config: QQTokenManagerConfig) {
  // Token state
  let tokenInfo: TokenInfo | null = null;
  let tokenRefreshPromise: Promise<string> | null = null;

  async function getAccessToken(): Promise<string> {
    // Check cached token
    if (
      tokenInfo &&
      Date.now() < tokenInfo.expiresAt - TOKEN_REFRESH_BUFFER_MS
    ) {
      return tokenInfo.accessToken;
    }

    // Singleflight: reuse in-flight refresh
    if (tokenRefreshPromise) {
      return tokenRefreshPromise;
    }

    tokenRefreshPromise = refreshToken();
    try {
      return await tokenRefreshPromise;
    } finally {
      tokenRefreshPromise = null;
    }
  }

  async function refreshToken(): Promise<string> {
    const body = JSON.stringify({
      appId: config.appId,
      clientSecret: config.appSecret,
    });

    return new Promise<string>((resolve, reject) => {
      const url = new URL(QQ_TOKEN_URL);
      const req = https.request(
        {
          hostname: url.hostname,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let responseBytes = 0;
          res.on('data', (chunk: Buffer) => {
            responseBytes += chunk.length;
            if (responseBytes > QQ_MAX_JSON_RESPONSE_BYTES) {
              res.destroy(new Error('QQ token response is too large'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            try {
              const text = Buffer.concat(chunks).toString('utf-8');
              const data = JSON.parse(text);
              if (res.statusCode && res.statusCode >= 400) {
                reject(
                  new Error(
                    `QQ token request failed (${res.statusCode}): ${String(data.message || data.msg || 'unknown error').slice(0, 500)}`,
                  ),
                );
                return;
              }
              if (!data.access_token) {
                reject(
                  new Error(
                    `QQ token response missing access_token: ${JSON.stringify(data).slice(0, 500)}`,
                  ),
                );
                return;
              }
              const expiresIn = Number(data.expires_in) || 7200;
              tokenInfo = {
                accessToken: data.access_token,
                expiresAt: Date.now() + expiresIn * 1000,
              };
              logger.info({ expiresIn }, 'QQ access token refreshed');
              resolve(data.access_token);
            } catch (err) {
              reject(err);
            }
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.setTimeout(QQ_TOKEN_REQUEST_TIMEOUT_MS, () => {
        req.destroy(new Error('QQ token request timed out'));
      });
      req.write(body);
      req.end();
    });
  }

  return {
    getAccessToken,
    resetToken: () => {
      tokenInfo = null;
    },
  };
}
