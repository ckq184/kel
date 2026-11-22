/**
 * WeChat iLink HTTP 客户端（原 src/wechat.ts createWeChatConnection 工厂内
 * “HTTP Helpers”+“API Methods”的 getupdates 段 wechat.ts:509-599，及仅该段
 * 消费的模块级素材——randomWechatUin 助手 wechat.ts:301-308、wechatUin 生成
 * 行 wechat.ts:471-472、LONGPOLL_EXTRA_TIMEOUT_MS / CHANNEL_VERSION 常数、
 * GetUpdatesResponse 接口 wechat.ts:268-275——ISSUE-12 单元 2.17 原文搬运）。
 *
 * 职责：
 *   - ensureDispatcher：bypassProxy 派发的 undici Dispatcher 惰性单例；
 *   - publishState：connectionState 写点 + onConnectionStateChange 透传
 *     （publishState 为 W1 自产，进本工厂返回面；其唯一写点 connectionState
 *     随之内化持有，wechat.ts 留守读点经返回面 getConnectionState() 活读）；
 *   - buildHeaders / baseInfo：iLink 请求头（botToken / X-WECHAT-UIN /
 *     weChatIlinkHeaders）与渠道标识；
 *   - apiPost：fetch + AbortController 超时 + WECHAT_REQUEST_TIMEOUT 归一
 *     （trackAsPollRequest 为长轮询抢占通道）；
 *   - getUpdates：长轮询请求（longpollTimeoutMs + LONGPOLL_EXTRA_TIMEOUT_MS
 *     客户端超时）。
 *
 * 闭包状态归属（2.14 qq-ws 同款判断）：dispatcher / activePollController /
 * longpollTimeoutMs / currentGetUpdatesBuf / activeOpts 均有搬运体之外的
 * 消费者（closeDispatcher 关闭句柄 / disconnect 复位清理行 / pollLoop 游标
 * 与超时回写 / connect 门面），本体留守 src/wechat.ts 状态区，本模块经
 * get/set 访问器对读写（读点活读语义保持）。
 *
 * 依赖注入（闭包依赖显式参数化，feishu/qq 系列同款机械替换）：
 *   - config：WeChatConnectionConfig 的结构子集（botToken / baseUrl? /
 *     bypassProxy?）；baseUrl / bypassProxy 派生表达式与 wechat.ts 原行
 *     逐字节一致，DEFAULT_BASE_URL 随本模块安家并导出、wechat.ts 回接
 *     import（2.12 QQ_MAX_JSON_RESPONSE_BYTES 回接同款）；
 *   - deps：createWeChatConnection 第二参原样透传，fetch / createDispatcher
 *     的默认值解析行随 apiPost / ensureDispatcher 迁入——
 *     wechat-connection-lifecycle 的注入链穿透到本层（random / now 由留守
 *     的 W6/W7 在 wechat.ts 解析消费，同一 deps 对象单点不变）；
 *   - parseWeChatApiResponse：src/wechat.ts 的既有导出（外层门面约束
 *     “既有导出不动”），留在原文件；本模块不回环 import 原文件（feishu/qq
 *     系列零 child→parent 回环先例），故经同名参数注入，搬运体内
 *     `parseWeChatApiResponse<T>(res, endpoint)` 逐字节不变（2.12
 *     validateQQGatewayUrl 同款）。
 *
 * 类型镜像：WeChatConnectionErrorCode / WeChatConnectionState /
 * WeixinMessage / MessageItem / CDNMedia 为 src/wechat.ts 同名定义的逐字节
 * 结构镜像（本模块不回环 import 原文件；两侧经结构化类型双向互通，
 * wechat.ts 原定义与其导出面不动）；GetUpdatesResponse 仅 getUpdates
 * 消费，随段迁移为本模块原定义。
 */
import crypto from 'crypto';
import { fetch as undiciFetch, type Dispatcher } from 'undici';
import { weChatIlinkHeaders } from './wechat-onboarding.js';
import { createWeChatHttpDispatcher } from './wechat-http.js';

// ─── Constants ──────────────────────────────────────────────────

// 原 wechat.ts:42（baseUrl 派生共享：本模块 apiPost 与 wechat.ts 留守的
// sendImage/sendFile 日志与上传链都消费，单一定义随 api 层安家）。
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';

// 原 wechat.ts:47（仅 getUpdates 消费，随段迁移）。
const LONGPOLL_EXTRA_TIMEOUT_MS = 5000;

// 原 wechat.ts:56（仅 baseInfo 消费，随段迁移）。
const CHANNEL_VERSION = '1.0.0';

// ─── Types ──────────────────────────────────────────────────────

// src/wechat.ts 的 WeChatConnectionErrorCode（未导出）的逐字节结构镜像。
type WeChatConnectionErrorCode =
  | 'connect_timeout'
  | 'request_timeout'
  | 'connection_reset'
  | 'tls_error'
  | 'api_error'
  | 'network_error'
  | 'unknown';

// src/wechat.ts 的 WeChatConnectionState（已导出，外层门面约束不动）的
// 逐字节结构镜像。
interface WeChatConnectionState {
  status:
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'expired'
    | 'disconnected';
  error?: string;
  errorCode?: WeChatConnectionErrorCode;
  consecutiveFailures?: number;
  nextRetryMs?: number;
  lastConnectedAt?: string;
}

// src/wechat.ts 的 WeixinMessage / MessageItem / CDNMedia（均未导出）的
// 逐字节结构镜像——GetUpdatesResponse.msgs 引用链所需；wechat.ts 留守的
// W4/W5 入站管线继续使用原定义，两侧经结构化类型双向互通。
interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

interface MessageItem {
  type?: number;
  text_item?: { text?: string };
  image_item?: { media?: CDNMedia; aeskey?: string; url?: string };
  voice_item?: { media?: CDNMedia; text?: string };
  file_item?: { media?: CDNMedia; file_name?: string };
  video_item?: { media?: CDNMedia };
  ref_msg?: { message_item?: MessageItem; title?: string };
}

interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
}

// 原 wechat.ts:268-275 的 GetUpdatesResponse（仅 getUpdates 消费）随段迁移，
// 字段逐字节一致。
interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Generate random X-WECHAT-UIN header value.
 * A random uint32 converted to string, then base64-encoded.
 */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

// ─── Wiring Types ────────────────────────────────────────────────

// src/wechat.ts 的 WeChatConnectionConfig 的结构子集——仅收 HTTP 层实际
// 消费的 botToken / baseUrl? / bypassProxy?；完整配置经结构化类型自然满足。
interface WeChatApiClientConfig {
  botToken: string;
  baseUrl?: string;
  bypassProxy?: boolean;
}

// src/wechat.ts 的 WeChatConnectionDeps（未导出）的结构子集——仅收 HTTP 层
// 实际消费的 fetch / createDispatcher（random / now 由 wechat.ts 留守的
// W6/W7 解析消费）；createWeChatConnection 收到的完整 deps 原样透传，经
// 结构化类型自然满足。
interface WeChatApiClientDeps {
  fetch?: typeof undiciFetch;
  createDispatcher?: (bypassProxy: boolean) => Dispatcher;
}

// src/wechat.ts 的 WeChatConnectOpts 的结构子集——仅收 publishState 实际
// 消费的 onConnectionStateChange 字段；activeOpts 的完整
// WeChatConnectOpts 运行时值经结构化类型自然满足。
interface WeChatApiConnectOpts {
  onConnectionStateChange?: (state: WeChatConnectionState) => void;
}

/**
 * 留守闭包状态与同名注入依赖的访问器集（本体留 src/wechat.ts 状态区，
 * 2.14 qq-ws 状态留守同款）。
 *
 * parseWeChatApiResponse：src/wechat.ts 的既有导出（外层门面约束），经
 * 同名参数注入（2.12 validateQQGatewayUrl 同款），apiPost 体内调用点
 * 逐字节不变。
 */
export interface WeChatApiClientState {
  parseWeChatApiResponse: <T>(
    response: Response,
    endpoint: string,
  ) => Promise<T>;
  getActiveOpts: () => WeChatApiConnectOpts | null;
  getDispatcher: () => Dispatcher | null;
  setDispatcher: (dispatcher: Dispatcher | null) => void;
  getActivePollController: () => AbortController | null;
  setActivePollController: (controller: AbortController | null) => void;
  getLongpollTimeoutMs: () => number;
  getCurrentGetUpdatesBuf: () => string;
}

// ─── Factory ─────────────────────────────────────────────────────

export function createWeChatApiClient(
  config: WeChatApiClientConfig,
  deps: WeChatApiClientDeps,
  state: WeChatApiClientState,
) {
  const {
    parseWeChatApiResponse,
    getActiveOpts,
    getDispatcher,
    setDispatcher,
    getActivePollController,
    setActivePollController,
    getLongpollTimeoutMs,
    getCurrentGetUpdatesBuf,
  } = state;

  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  const bypassProxy = config.bypassProxy !== false;
  const fetchImpl = deps.fetch ?? undiciFetch;
  const createDispatcher = deps.createDispatcher ?? createWeChatHttpDispatcher;

  let connectionState: WeChatConnectionState = { status: 'disconnected' };

  // Generate UIN once per connection instance (no need to regenerate per request)
  const wechatUin = randomWechatUin();

  // ─── HTTP Helpers ─────────────────────────────────────────

  function ensureDispatcher(): Dispatcher {
    const dispatcher = getDispatcher() ?? createDispatcher(bypassProxy);
    setDispatcher(dispatcher);
    return dispatcher;
  }

  function publishState(state: WeChatConnectionState): void {
    connectionState = state;
    getActiveOpts()?.onConnectionStateChange?.(state);
  }

  /** wechat.ts 留守读点（connect 状态重放 / pollLoop expired 判定）的活读访问器。 */
  function getConnectionState(): WeChatConnectionState {
    return connectionState;
  }

  function buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      Authorization: `Bearer ${config.botToken}`,
      'X-WECHAT-UIN': wechatUin,
      ...weChatIlinkHeaders(),
    };
  }

  function baseInfo(): Record<string, string> {
    return {
      channel_version: CHANNEL_VERSION,
      bot_agent: `CKQClaw/${CHANNEL_VERSION}`,
    };
  }

  /**
   * Make an HTTPS POST request to the iLink API using fetch.
   */
  async function apiPost<T = any>(
    endpoint: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
    trackAsPollRequest = false,
  ): Promise<T> {
    const bodyStr = JSON.stringify(body);
    const url = new URL(endpoint, baseUrl);
    const headers = buildHeaders();

    const controller = new AbortController();
    if (trackAsPollRequest) setActivePollController(controller);
    const timer = timeoutMs
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined;

    try {
      const res = await fetchImpl(url.toString(), {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': String(Buffer.byteLength(bodyStr, 'utf-8')),
        },
        body: bodyStr,
        signal: controller.signal,
        dispatcher: ensureDispatcher(),
      });

      return await parseWeChatApiResponse<T>(res, endpoint);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw Object.assign(
          new Error(`WeChat API ${endpoint} timed out`, { cause: err }),
          { code: 'WECHAT_REQUEST_TIMEOUT' },
        );
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      if (trackAsPollRequest && getActivePollController() === controller) {
        setActivePollController(null);
      }
    }
  }

  // ─── API Methods ──────────────────────────────────────────

  async function getUpdates(): Promise<GetUpdatesResponse> {
    const httpTimeout = getLongpollTimeoutMs() + LONGPOLL_EXTRA_TIMEOUT_MS;
    return apiPost<GetUpdatesResponse>(
      'ilink/bot/getupdates',
      {
        get_updates_buf: getCurrentGetUpdatesBuf(),
        base_info: baseInfo(),
      },
      httpTimeout,
      true,
    );
  }

  return {
    ensureDispatcher,
    publishState,
    getConnectionState,
    buildHeaders,
    baseInfo,
    apiPost,
    getUpdates,
  };
}
