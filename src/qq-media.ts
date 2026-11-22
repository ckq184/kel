/**
 * QQ 富媒体发送与附件下载（原 src/qq.ts 模块级“QQ File Upload Types &
 * Constants”与“Chunked Upload Utilities”两段 qq.ts:62-241，及
 * createQQConnection 工厂内 uploadCache 状态簇 qq.ts:405-473 与
 * Image Sending / Chunked File Upload / File Download 三段
 * qq.ts:528-1023，ISSUE-12 单元 2.13 原文搬运）。
 *
 * 职责：
 *   - uploadCache：同内容文件 TTL 内免重传（容量 500，懒淘汰 + 半数丢弃）；
 *   - uploadMedia / sendQQImageMessage：图片直传（10MB 上限）；
 *   - 分片上传链：qqUploadPrepare → putToPresignedUrl → qqUploadPartFinish
 *     （40093001 可重试码 persistent retry）→ qqCompleteUpload，由
 *     chunkedUpload 编排，sendQQFileMessage 收口（30MB 上限）；
 *   - downloadQQAttachment / processQQAttachment：入站附件下载（重定向
 *     跟随 + MAX_FILE_SIZE 上限）、类型探测、落盘与文件文本内联
 *     （?? 回退仅路径标记）。
 *
 * 依赖注入（闭包依赖显式参数化，feishu 系列同款机械替换）：
 *   - api.apiRequest：2.12 createQQApi 返回面的结构子集，同名解构；
 *   - getNextMsgSeq：2.16 门面转发状态（msgSeqCounters 本体留 src/qq.ts），
 *     同名参数注入，sendQQImageMessage / sendQQFileMessage 的 msg_seq
 *     计数调用逐字节保留。
 *
 * qqPartFinishPersistentRetry 的 setTimeout 轮询归本工厂所有：现状即不绑
 * WS stop 链（deadline 到点自然终止），原样保持（plan §4.2 风险注记）。
 *
 * QQApiError 自 './qq-api.js' import（2.12 已随唯一 throw 侧安家该模块），
 * qqUploadPartFinish / qqPartFinishPersistentRetry 的 instanceof 判定引用
 * 同一类身份，搬运体逐字节保留。
 *
 * processQQAttachment 的 opts 参数收窄为 QQMediaConnectOpts——src/qq.ts 的
 * QQConnectOpts（未导出）的结构子集，仅收附件处理实际消费的
 * resolveGroupFolder 字段；完整 QQConnectOpts 经结构化类型自然满足。
 * 搬运体除该类型注解外逐字节保留。
 */
import crypto from 'crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { logger } from './logger.js';
import {
  saveDownloadedFile,
  buildInlinedFileContent,
  MAX_FILE_SIZE,
} from './im-downloader.js';
import { detectImageMimeTypeStrict } from './image-detector.js';
import path from 'node:path';
import { QQApiError } from './qq-api.js';

const IMAGE_EXT_MAP: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// ─── QQ File Upload Types & Constants ──────────────────────────

enum QQMediaFileType {
  IMAGE = 1,
  VIDEO = 2,
  VOICE = 3,
  FILE = 4,
}

interface UploadPrepareHashes {
  md5: string;
  sha1: string;
  md5_10m: string;
}

interface QQUploadPart {
  index: number;
  presigned_url: string;
}

interface QQUploadPrepareResponse {
  upload_id: string;
  block_size: number;
  parts: QQUploadPart[];
  concurrency?: number;
  retry_timeout?: number;
}

interface QQMediaUploadResponse {
  file_uuid: string;
  file_info: string;
  ttl: number;
}

const QQ_FILE_MAX_SIZE = 30 * 1024 * 1024; // 30MB (consistent with other channels)
const MD5_10M_SIZE = 10_002_432;
const PART_UPLOAD_TIMEOUT = 300_000; // 5 min
const PART_UPLOAD_MAX_RETRIES = 2;
const PART_FINISH_MAX_RETRIES = 2;
const PART_FINISH_BASE_DELAY_MS = 1000;
const PART_FINISH_RETRYABLE_CODES = new Set([40093001]);
const PART_FINISH_RETRYABLE_DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
const PART_FINISH_RETRYABLE_INTERVAL_MS = 1000;
const MAX_PART_FINISH_RETRY_TIMEOUT_MS = 10 * 60 * 1000;
const COMPLETE_UPLOAD_MAX_RETRIES = 2;
const COMPLETE_UPLOAD_BASE_DELAY_MS = 1000;
const DEFAULT_CONCURRENT_PARTS = 1;
const MAX_CONCURRENT_PARTS = 10;

function getQQMediaFileType(fileName: string): QQMediaFileType {
  const ext = path.extname(fileName).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext))
    return QQMediaFileType.IMAGE;
  if (['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext))
    return QQMediaFileType.VIDEO;
  if (['.mp3', '.wav', '.silk', '.ogg'].includes(ext))
    return QQMediaFileType.VOICE;
  return QQMediaFileType.FILE;
}

// ─── Chunked Upload Utilities ──────────────────────────────────

async function computeFileHashes(
  filePath: string,
  fileSize: number,
): Promise<UploadPrepareHashes> {
  return new Promise((resolve, reject) => {
    const md5Hash = crypto.createHash('md5');
    const sha1Hash = crypto.createHash('sha1');
    const md5_10mHash = crypto.createHash('md5');

    let bytesRead = 0;
    const need10m = fileSize > MD5_10M_SIZE;

    const stream = fs.createReadStream(filePath);

    stream.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      md5Hash.update(buf);
      sha1Hash.update(buf);

      if (need10m) {
        const remaining = MD5_10M_SIZE - bytesRead;
        if (remaining > 0) {
          md5_10mHash.update(
            remaining >= buf.length ? buf : buf.subarray(0, remaining),
          );
        }
      }
      bytesRead += buf.length;
    });

    stream.on('end', () => {
      const md5 = md5Hash.digest('hex');
      const sha1 = sha1Hash.digest('hex');
      const md5_10m = need10m ? md5_10mHash.digest('hex') : md5;
      resolve({ md5, sha1, md5_10m });
    });

    stream.on('error', reject);
  });
}

async function readFileChunk(
  filePath: string,
  offset: number,
  length: number,
): Promise<Buffer> {
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await fd.read(buffer, 0, length, offset);
    return bytesRead < length ? buffer.subarray(0, bytesRead) : buffer;
  } finally {
    await fd.close();
  }
}

async function putToPresignedUrl(
  presignedUrl: string,
  data: Buffer,
  partIndex: number,
  totalParts: number,
): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= PART_UPLOAD_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PART_UPLOAD_TIMEOUT);

    try {
      const response = await fetch(presignedUrl, {
        method: 'PUT',
        body: data,
        headers: { 'Content-Length': String(data.length) },
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `COS PUT failed: ${response.status} ${response.statusText} - ${body}`,
        );
      }
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (lastError.name === 'AbortError') {
        lastError = new Error(
          `Part ${partIndex}/${totalParts} upload timeout after ${PART_UPLOAD_TIMEOUT}ms`,
        );
      }
      if (attempt < PART_UPLOAD_MAX_RETRIES) {
        const delay = 1000 * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError!;
}

async function runWithConcurrency(
  tasks: Array<() => Promise<void>>,
  maxConcurrent: number,
): Promise<void> {
  for (let i = 0; i < tasks.length; i += maxConcurrent) {
    const batch = tasks.slice(i, i + maxConcurrent);
    await Promise.all(batch.map((task) => task()));
  }
}

// src/qq.ts 的 createQQApi 返回面的结构子集——仅收媒体链实际消费的
// apiRequest；完整 api 对象经结构化类型自然满足。
export interface QQMediaApi {
  apiRequest: <T = any>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ) => Promise<T>;
}

// src/qq.ts 的 QQConnectOpts（未导出）的结构子集——仅收附件处理实际消费
// 的 resolveGroupFolder 字段；完整 QQConnectOpts 经结构化类型自然满足。
interface QQMediaConnectOpts {
  resolveGroupFolder?: (jid: string) => string | undefined;
}

export function createQQMediaSender(
  api: QQMediaApi,
  getNextMsgSeq: (chatId: string) => number,
) {
  const { apiRequest } = api;

  // Upload cache: avoid re-uploading identical files within TTL
  const UPLOAD_CACHE_MAX = 500;
  const UPLOAD_CACHE_TTL_MARGIN_S = 60; // expire 60s early for safety
  interface UploadCacheEntry {
    fileInfo: string;
    expiresAt: number; // ms
  }
  const uploadCache = new Map<string, UploadCacheEntry>();

  function getUploadCacheKey(
    md5: string,
    chatType: 'c2c' | 'group',
    openid: string,
    fileType: number,
  ): string {
    return `${md5}:${chatType}:${openid}:${fileType}`;
  }

  function getCachedFileInfo(
    md5: string,
    chatType: 'c2c' | 'group',
    openid: string,
    fileType: number,
  ): string | null {
    const key = getUploadCacheKey(md5, chatType, openid, fileType);
    const entry = uploadCache.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      uploadCache.delete(key);
      return null;
    }
    logger.info({ key: key.slice(0, 40) }, 'QQ upload cache HIT');
    return entry.fileInfo;
  }

  function setCachedFileInfo(
    md5: string,
    chatType: 'c2c' | 'group',
    openid: string,
    fileType: number,
    fileInfo: string,
    ttlSeconds: number,
  ): void {
    // Lazy eviction of expired entries when at capacity
    if (uploadCache.size >= UPLOAD_CACHE_MAX) {
      const now = Date.now();
      for (const [k, v] of uploadCache) {
        if (now >= v.expiresAt) uploadCache.delete(k);
      }
      // Still full → drop oldest half
      if (uploadCache.size >= UPLOAD_CACHE_MAX) {
        const keys = Array.from(uploadCache.keys());
        for (let i = 0; i < keys.length / 2; i++) {
          uploadCache.delete(keys[i]!);
        }
      }
    }

    const effectiveTtl = Math.max(ttlSeconds - UPLOAD_CACHE_TTL_MARGIN_S, 10);
    const key = getUploadCacheKey(md5, chatType, openid, fileType);
    uploadCache.set(key, {
      fileInfo,
      expiresAt: Date.now() + effectiveTtl * 1000,
    });
    logger.info(
      { key: key.slice(0, 40), ttl: effectiveTtl },
      'QQ upload cache SET',
    );
  }

  // ─── Image Sending ───────────────────────────────────────

  const QQ_UPLOAD_MAX_SIZE = 10 * 1024 * 1024; // 10MB

  async function uploadMedia(
    chatType: 'c2c' | 'group',
    openid: string,
    imageBuffer: Buffer,
  ): Promise<string> {
    if (imageBuffer.length > QQ_UPLOAD_MAX_SIZE) {
      throw new Error(
        `Image too large for QQ upload: ${(imageBuffer.length / 1024 / 1024).toFixed(1)}MB (max 10MB)`,
      );
    }

    // Check upload cache
    const md5 = crypto.createHash('md5').update(imageBuffer).digest('hex');
    const cached = getCachedFileInfo(
      md5,
      chatType,
      openid,
      QQMediaFileType.IMAGE,
    );
    if (cached) return cached;

    const endpoint =
      chatType === 'c2c'
        ? `/v2/users/${openid}/files`
        : `/v2/groups/${openid}/files`;

    const res = await apiRequest<{
      file_info: string;
      file_uuid?: string;
      ttl?: number;
    }>('POST', endpoint, {
      file_type: 1, // 1 = image
      file_data: imageBuffer.toString('base64'),
      srv_send_msg: false,
    });
    if (!res.file_info) {
      throw new Error('QQ uploadMedia: no file_info in response');
    }

    // Cache the result
    if (res.ttl && res.ttl > 0) {
      setCachedFileInfo(
        md5,
        chatType,
        openid,
        QQMediaFileType.IMAGE,
        res.file_info,
        res.ttl,
      );
    }

    return res.file_info;
  }

  async function sendQQImageMessage(
    chatType: 'c2c' | 'group',
    openid: string,
    imageBuffer: Buffer,
    caption?: string,
  ): Promise<void> {
    const fileInfo = await uploadMedia(chatType, openid, imageBuffer);
    const chatKey = `${chatType}:${openid}`;
    const msgSeq = getNextMsgSeq(chatKey);

    const endpoint =
      chatType === 'c2c'
        ? `/v2/users/${openid}/messages`
        : `/v2/groups/${openid}/messages`;

    await apiRequest('POST', endpoint, {
      msg_type: 7, // rich media
      media: { file_info: fileInfo },
      content: caption || '',
      msg_seq: msgSeq,
    });
  }

  // ─── Chunked File Upload ─────────────────────────────────────

  async function qqUploadPrepare(
    chatType: 'c2c' | 'group',
    openid: string,
    fileType: QQMediaFileType,
    fileName: string,
    fileSize: number,
    hashes: UploadPrepareHashes,
  ): Promise<QQUploadPrepareResponse> {
    const endpoint =
      chatType === 'c2c'
        ? `/v2/users/${openid}/upload_prepare`
        : `/v2/groups/${openid}/upload_prepare`;

    return apiRequest<QQUploadPrepareResponse>('POST', endpoint, {
      file_type: fileType,
      file_name: fileName,
      file_size: fileSize,
      md5: hashes.md5,
      sha1: hashes.sha1,
      md5_10m: hashes.md5_10m,
    });
  }

  async function qqUploadPartFinish(
    chatType: 'c2c' | 'group',
    openid: string,
    uploadId: string,
    partIndex: number,
    blockSize: number,
    md5: string,
    retryTimeoutMs?: number,
  ): Promise<void> {
    const endpoint =
      chatType === 'c2c'
        ? `/v2/users/${openid}/upload_part_finish`
        : `/v2/groups/${openid}/upload_part_finish`;

    const body = {
      upload_id: uploadId,
      part_index: partIndex,
      block_size: blockSize,
      md5,
    };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= PART_FINISH_MAX_RETRIES; attempt++) {
      try {
        await apiRequest('POST', endpoint, body);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Retryable biz code → persistent retry
        if (
          err instanceof QQApiError &&
          err.bizCode !== undefined &&
          PART_FINISH_RETRYABLE_CODES.has(err.bizCode)
        ) {
          const timeoutMs =
            retryTimeoutMs ?? PART_FINISH_RETRYABLE_DEFAULT_TIMEOUT_MS;
          logger.warn(
            { bizCode: err.bizCode, timeoutMs },
            'QQ partFinish hit retryable bizCode, entering persistent retry',
          );
          await qqPartFinishPersistentRetry(endpoint, body, timeoutMs);
          return;
        }

        if (attempt < PART_FINISH_MAX_RETRIES) {
          const delay = PART_FINISH_BASE_DELAY_MS * Math.pow(2, attempt);
          logger.warn(
            { attempt: attempt + 1, err: lastError.message },
            'QQ partFinish failed, retrying',
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError!;
  }

  async function qqPartFinishPersistentRetry(
    endpoint: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;

    while (Date.now() < deadline) {
      try {
        await apiRequest('POST', endpoint, body);
        logger.info({ attempt }, 'QQ partFinish persistent retry succeeded');
        return;
      } catch (err) {
        if (
          !(err instanceof QQApiError) ||
          err.bizCode === undefined ||
          !PART_FINISH_RETRYABLE_CODES.has(err.bizCode)
        ) {
          throw err;
        }
        attempt++;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(PART_FINISH_RETRYABLE_INTERVAL_MS, remaining),
          ),
        );
      }
    }

    throw new Error(
      `QQ upload_part_finish persistent retry timed out (${timeoutMs / 1000}s, ${attempt} attempts)`,
    );
  }

  async function qqCompleteUpload(
    chatType: 'c2c' | 'group',
    openid: string,
    uploadId: string,
  ): Promise<QQMediaUploadResponse> {
    const endpoint =
      chatType === 'c2c'
        ? `/v2/users/${openid}/files`
        : `/v2/groups/${openid}/files`;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= COMPLETE_UPLOAD_MAX_RETRIES; attempt++) {
      try {
        return await apiRequest<QQMediaUploadResponse>('POST', endpoint, {
          upload_id: uploadId,
        });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < COMPLETE_UPLOAD_MAX_RETRIES) {
          const delay = COMPLETE_UPLOAD_BASE_DELAY_MS * Math.pow(2, attempt);
          logger.warn(
            { attempt: attempt + 1, err: lastError.message },
            'QQ completeUpload failed, retrying',
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError!;
  }

  async function chunkedUpload(
    chatType: 'c2c' | 'group',
    openid: string,
    filePath: string,
    fileType: QQMediaFileType,
  ): Promise<string> {
    const stat = await fs.promises.stat(filePath);
    const fileSize = stat.size;
    const fileName = path.basename(filePath);

    logger.info({ fileName, fileSize, fileType }, 'QQ chunked upload starting');

    const hashes = await computeFileHashes(filePath, fileSize);

    // Check upload cache
    const cached = getCachedFileInfo(hashes.md5, chatType, openid, fileType);
    if (cached) return cached;

    const prepareResp = await qqUploadPrepare(
      chatType,
      openid,
      fileType,
      fileName,
      fileSize,
      hashes,
    );

    const { upload_id, parts } = prepareResp;
    const block_size = Number(prepareResp.block_size);

    const maxConcurrent = Math.min(
      prepareResp.concurrency
        ? Number(prepareResp.concurrency)
        : DEFAULT_CONCURRENT_PARTS,
      MAX_CONCURRENT_PARTS,
    );

    const retryTimeoutMs = prepareResp.retry_timeout
      ? Math.min(
          Number(prepareResp.retry_timeout) * 1000,
          MAX_PART_FINISH_RETRY_TIMEOUT_MS,
        )
      : undefined;

    logger.info(
      { upload_id, block_size, parts: parts.length, maxConcurrent },
      'QQ upload prepared',
    );

    const uploadPart = async (part: QQUploadPart): Promise<void> => {
      const offset = (part.index - 1) * block_size;
      const length = Math.min(block_size, fileSize - offset);

      const partBuffer = await readFileChunk(filePath, offset, length);
      const md5Hex = crypto.createHash('md5').update(partBuffer).digest('hex');

      await putToPresignedUrl(
        part.presigned_url,
        partBuffer,
        part.index,
        parts.length,
      );

      await qqUploadPartFinish(
        chatType,
        openid,
        upload_id,
        part.index,
        length,
        md5Hex,
        retryTimeoutMs,
      );
    };

    await runWithConcurrency(
      parts.map((part) => () => uploadPart(part)),
      maxConcurrent,
    );

    const result = await qqCompleteUpload(chatType, openid, upload_id);
    logger.info(
      { file_uuid: result.file_uuid, ttl: result.ttl },
      'QQ chunked upload completed',
    );

    // Cache the result
    if (result.ttl > 0) {
      setCachedFileInfo(
        hashes.md5,
        chatType,
        openid,
        fileType,
        result.file_info,
        result.ttl,
      );
    }

    return result.file_info;
  }

  async function sendQQFileMessage(
    chatType: 'c2c' | 'group',
    openid: string,
    filePath: string,
    fileName: string,
  ): Promise<void> {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > QQ_FILE_MAX_SIZE) {
      throw new Error(
        `File too large for QQ upload: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max ${QQ_FILE_MAX_SIZE / 1024 / 1024}MB)`,
      );
    }

    const fileType = getQQMediaFileType(fileName);
    const fileInfo = await chunkedUpload(chatType, openid, filePath, fileType);

    const chatKey = `${chatType}:${openid}`;
    const msgSeq = getNextMsgSeq(chatKey);

    const endpoint =
      chatType === 'c2c'
        ? `/v2/users/${openid}/messages`
        : `/v2/groups/${openid}/messages`;

    await apiRequest('POST', endpoint, {
      msg_type: 7,
      media: { file_info: fileInfo },
      content: '',
      msg_seq: msgSeq,
    });
  }

  // ─── File Download ─────────────────────────────────────────

  async function downloadQQAttachment(url: string): Promise<Buffer | null> {
    try {
      const buffer = await new Promise<Buffer>((resolve, reject) => {
        const doRequest = (reqUrl: string, redirectCount: number = 0) => {
          if (redirectCount > 5) {
            reject(new Error('Too many redirects'));
            return;
          }
          const parsedUrl = new URL(reqUrl);
          const protocol = parsedUrl.protocol === 'https:' ? https : http;
          protocol
            .get(reqUrl, (res) => {
              if (
                res.statusCode &&
                res.statusCode >= 300 &&
                res.statusCode < 400 &&
                res.headers.location
              ) {
                doRequest(res.headers.location, redirectCount + 1);
                return;
              }
              const chunks: Buffer[] = [];
              let total = 0;
              res.on('data', (chunk: Buffer) => {
                total += chunk.length;
                if (total > MAX_FILE_SIZE) {
                  res.destroy(new Error('File exceeds MAX_FILE_SIZE'));
                  return;
                }
                chunks.push(chunk);
              });
              res.on('end', () => resolve(Buffer.concat(chunks)));
              res.on('error', reject);
            })
            .on('error', reject);
        };
        doRequest(url);
      });

      if (buffer.length === 0) return null;
      return buffer;
    } catch (err) {
      logger.warn({ err }, 'Failed to download QQ attachment');
      return null;
    }
  }

  /**
   * Process a QQ attachment (image or file): download, detect type, save to disk.
   * Returns updated content string and optional attachmentsJson for vision.
   */
  async function processQQAttachment(
    attachment: { url?: string; filename?: string },
    msgId: string,
    jid: string,
    content: string,
    opts: QQMediaConnectOpts,
    logContext: string,
  ): Promise<{ content: string; attachmentsJson?: string }> {
    if (!attachment.url) return { content };

    const attachUrl = attachment.url.startsWith('http')
      ? attachment.url
      : `https://${attachment.url}`;
    const buffer = await downloadQQAttachment(attachUrl);
    if (!buffer) return { content };

    const imageMime = detectImageMimeTypeStrict(buffer);
    const groupFolder = opts.resolveGroupFolder?.(jid);

    if (imageMime) {
      const attachmentsJson = JSON.stringify([
        { type: 'image', data: buffer.toString('base64'), mimeType: imageMime },
      ]);

      if (groupFolder) {
        const ext = IMAGE_EXT_MAP[imageMime] ?? '.jpg';
        const fileName = `qq_img_${msgId.slice(-8)}${ext}`;
        try {
          const relPath = await saveDownloadedFile(
            groupFolder,
            'qq',
            fileName,
            buffer,
          );
          if (relPath) content = `[图片: ${relPath}]\n${content}`.trim();
        } catch (err) {
          logger.warn({ err }, `Failed to save QQ ${logContext} image`);
        }
      }

      if (!content) content = '[图片]';
      return { content, attachmentsJson };
    }

    // Non-image file
    const urlFilename =
      attachment.filename ||
      attachUrl.split('/').pop()?.split('?')[0] ||
      `qq_file_${msgId.slice(-8)}`;
    const fileName = urlFilename.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff]/g, '_');

    if (groupFolder) {
      try {
        const relPath = await saveDownloadedFile(
          groupFolder,
          'qq',
          fileName,
          buffer,
        );
        if (relPath) {
          // 弱模型兜底：抽取成功则内联文件文本，失败回退仅路径标记。
          const inlined =
            (await buildInlinedFileContent(groupFolder, relPath)) ??
            `[文件: ${relPath}]`;
          content = `${inlined}\n${content}`.trim();
        }
      } catch (err) {
        logger.warn({ err }, `Failed to save QQ ${logContext} file`);
      }
    }

    if (!content) content = '[文件]';
    return { content };
  }

  return {
    sendQQImageMessage,
    sendQQFileMessage,
    processQQAttachment,
  };
}
