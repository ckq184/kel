/**
 * WeChat iLink 入站 CDN 媒体下载链（原 src/wechat.ts createWeChatConnection
 * 工厂内 “CDN Media Download”段 downloadCdnMediaItem / processImageItem /
 * processFileItem（原 wechat.ts:543-670），及仅该段消费的模块级素材——
 * IMAGE_MAX_BASE64_SIZE 常数、saveDownloadedFile / buildInlinedFileContent /
 * MAX_FILE_SIZE / detectImageMimeType / downloadAndDecryptMedia 五个 import、
 * cdnBaseUrl 派生行——ISSUE-12 单元 2.19 原文搬运）。
 *
 * 三函数体逐字节零替换：原段位于 createWeChatConnection 工厂体内 2 空格
 * 基位，与本工厂体内基位相同，连 dedent 都不需要。downloadCdnMediaItem
 * 仅 processImageItem / processFileItem 消费，随段内化不进返回面；两
 * process*Item 经返回面同名解构回接，W5 processMessage 两调用点零改动。
 *
 * 依赖注入（闭包依赖显式参数化，2.17/2.18 同款）：
 *   - api：2.17 createWeChatApiClient 返回面的结构子集——仅收媒体段实际
 *     消费的 ensureDispatcher（qq-stream { apiRequest } 单员子集同款）；
 *   - config：WeChatConnectionConfig 的结构子集（cdnBaseUrl?），cdnBaseUrl
 *     派生表达式与 wechat.ts 原行逐字节一致；DEFAULT_CDN_BASE_URL 自
 *     wechat-outbound sibling import（2.18 已随发送链安家该处，单一定义
 *     不重复）。
 *
 * CDN URL 构建归属核实：buildCdnDownloadUrl 为 src/wechat-crypto.ts 模块内
 * 私有（未导出），URL 构建在 downloadAndDecryptMedia 体内完成；W4 无本地
 * 包装，本模块如实直引 downloadAndDecryptMedia（encrypt_query_param /
 * aes_key / cdnBaseUrl / dispatcher 四参原样）。
 *
 * 类型镜像：MessageItem / CDNMedia 为 src/wechat.ts 同名定义（未导出）的
 * 逐字节结构镜像（2.17 wechat-api 同款；W5 processMessage /
 * extractTextContent 继续使用原定义，两侧经结构化类型双向互通）。
 *
 * 锚点：im-inbound-file-inline 的微信条目（im-downloader import /
 * (groupFolder, result.savedPath) 调用形 / ?? 回退模板）随本单元等强改锚
 * 本模块，断言文本逐字不变。
 */
import { type Dispatcher } from 'undici';
import { logger } from './logger.js';
import {
  saveDownloadedFile,
  buildInlinedFileContent,
  MAX_FILE_SIZE,
} from './im-downloader.js';
import { detectImageMimeType } from './image-detector.js';
import { downloadAndDecryptMedia } from './wechat-crypto.js';
import { DEFAULT_CDN_BASE_URL } from './wechat-outbound.js';

// ─── Constants ──────────────────────────────────────────────────

// 原 wechat.ts:51（仅 processImageItem 消费，随段迁移）。
const IMAGE_MAX_BASE64_SIZE = 5 * 1024 * 1024; // 5 MB for inline base64

// ─── Types ──────────────────────────────────────────────────────

// src/wechat.ts 的 MessageItem / CDNMedia（均未导出）的逐字节结构镜像——
// 2.17 wechat-api 同款；W5 processMessage / extractTextContent 继续使用
// 原定义，两侧经结构化类型双向互通。
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

// 2.17 src/wechat-api.ts 的 createWeChatApiClient 返回面的结构子集——仅收
// 媒体段实际消费的 ensureDispatcher；完整返回面经结构化类型自然满足。
export interface WeChatMediaApi {
  ensureDispatcher: () => Dispatcher;
}

// src/wechat.ts 的 WeChatConnectionConfig 的结构子集——仅收媒体段实际消费
// 的 cdnBaseUrl?；完整配置经结构化类型自然满足。
interface WeChatMediaConfig {
  cdnBaseUrl?: string;
}

// ─── Factory ─────────────────────────────────────────────────────

export function createWeChatMedia(
  api: WeChatMediaApi,
  config: WeChatMediaConfig,
) {
  const { ensureDispatcher } = api;

  const cdnBaseUrl = config.cdnBaseUrl || DEFAULT_CDN_BASE_URL;

  // ─── CDN Media Download ────────────────────────────────────

  /**
   * Download, decrypt, and save a CDN media item (image, file, etc.).
   * `resolveFileName` receives the decrypted buffer so callers can inspect
   * content (e.g. MIME-detect for images) before choosing a name.
   */
  async function downloadCdnMediaItem(
    media: CDNMedia | undefined,
    groupFolder: string | undefined,
    label: string,
    resolveFileName: (buffer: Buffer) => string,
  ): Promise<{ buffer: Buffer; savedPath?: string } | null> {
    if (!media?.encrypt_query_param || !media?.aes_key) {
      logger.debug(`WeChat ${label} missing media or aes_key, skipping`);
      return null;
    }

    const buffer = await downloadAndDecryptMedia(
      media.encrypt_query_param,
      media.aes_key,
      cdnBaseUrl,
      ensureDispatcher(),
    );

    if (!buffer || buffer.length === 0) {
      logger.warn(`WeChat ${label} download returned empty buffer`);
      return null;
    }

    if (buffer.length > MAX_FILE_SIZE) {
      logger.warn(
        { size: buffer.length },
        `WeChat ${label} exceeds max file size, skipping`,
      );
      return null;
    }

    let savedPath: string | undefined;
    if (groupFolder) {
      try {
        const fileName = resolveFileName(buffer);
        savedPath =
          (await saveDownloadedFile(groupFolder, 'wechat', fileName, buffer)) ??
          undefined;
      } catch (err) {
        logger.warn({ err }, `Failed to save WeChat ${label} to disk`);
      }
    }

    return { buffer, savedPath };
  }

  async function processImageItem(
    item: MessageItem,
    msgIdentifier: string,
    groupFolder: string | undefined,
  ): Promise<{
    attachmentEntry?: { type: string; data: string; mimeType: string };
    textPrefix?: string;
  }> {
    try {
      const result = await downloadCdnMediaItem(
        item.image_item?.media,
        groupFolder,
        'image',
        (buffer) => {
          const mimeType = detectImageMimeType(buffer);
          const extMap: Record<string, string> = {
            'image/jpeg': '.jpg',
            'image/png': '.png',
            'image/gif': '.gif',
            'image/webp': '.webp',
          };
          return `wechat_img_${msgIdentifier}${extMap[mimeType] ?? '.jpg'}`;
        },
      );
      if (!result) return {};

      const textPrefix = result.savedPath
        ? `[图片: ${result.savedPath}]`
        : undefined;

      let attachmentEntry:
        | { type: string; data: string; mimeType: string }
        | undefined;
      if (result.buffer.length <= IMAGE_MAX_BASE64_SIZE) {
        const mimeType = detectImageMimeType(result.buffer);
        attachmentEntry = {
          type: 'image',
          data: result.buffer.toString('base64'),
          mimeType,
        };
      }

      return { attachmentEntry, textPrefix };
    } catch (err) {
      logger.warn({ err }, 'WeChat image download/decrypt failed, skipping');
      return {};
    }
  }

  async function processFileItem(
    item: MessageItem,
    groupFolder: string | undefined,
  ): Promise<string | null> {
    const fileName = item.file_item?.file_name || 'unknown_file';
    try {
      const result = await downloadCdnMediaItem(
        item.file_item?.media,
        groupFolder,
        'file',
        () => fileName,
      );
      if (result?.savedPath) {
        // 弱模型兜底：抽取成功则内联文件文本，失败回退仅路径标记。
        const inlined = groupFolder
          ? await buildInlinedFileContent(groupFolder, result.savedPath)
          : null;
        return inlined ?? `[文件: ${result.savedPath}]`;
      }
      // CDN media unavailable, fall back to name-only label
      return `[文件: ${fileName}]`;
    } catch (err) {
      logger.warn({ err, fileName }, 'WeChat file download/decrypt failed');
      return `[文件: ${fileName}]`;
    }
  }

  return {
    processImageItem,
    processFileItem,
  };
}
