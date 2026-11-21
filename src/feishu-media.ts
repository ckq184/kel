import type * as lark from '@larksuiteoapi/node-sdk';
import {
  saveDownloadedFile,
  MAX_FILE_SIZE,
  FileTooLargeError,
} from './im-downloader.js';
import { logger } from './logger.js';
import { detectImageMimeType } from './image-detector.js';

// 飞书媒体下载辅助（原 src/feishu.ts 头部纯函数 + createFeishuConnection 工厂内闭包，
// ISSUE-12 单元 2.2 原文搬运）。外层 client 为可变 let，一律经 getClient 访问器注入；
// readFeishuResourceBuffer 保持自 src/feishu.ts re-export，
// tests/feishu-resource-timeout.test.ts 的既有导入路径不变。

// 资源请求（messageResource.get）与流式读取各自的硬超时预算
export const FEISHU_RESOURCE_REQUEST_TIMEOUT_MS = 15_000;
const FEISHU_RESOURCE_STREAM_TIMEOUT_MS = 30_000;

interface FeishuResourceStream extends AsyncIterable<unknown> {
  destroy?: (error?: Error) => void;
}

export function withFeishuHardTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      try {
        onTimeout?.();
      } finally {
        reject(error);
      }
    }, timeoutMs);
    timer.unref?.();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Read one SDK resource stream under a hard wall-clock and byte budget. */
export async function readFeishuResourceBuffer(
  stream: FeishuResourceStream,
  options: {
    timeoutMs?: number;
    maxBytes?: number;
    resourceLabel?: string;
  } = {},
): Promise<Buffer> {
  const label = options.resourceLabel ?? 'Feishu resource stream';
  const reading = (async () => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as Uint8Array);
      totalSize += buffer.length;
      if (options.maxBytes !== undefined && totalSize > options.maxBytes) {
        throw new FileTooLargeError(label, totalSize);
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  })();
  return withFeishuHardTimeout(
    reading,
    options.timeoutMs ?? FEISHU_RESOURCE_STREAM_TIMEOUT_MS,
    label,
    () => stream.destroy?.(new Error(`${label} timed out`)),
  );
}

/**
 * 下载飞书图片（type='image'）为 base64 附件（原工厂内闭包，原文搬运；
 * client 经 getClient 访问器注入）。
 */
export async function downloadFeishuImage(
  getClient: () => lark.Client | null,
  messageId: string,
  fileKey: string,
): Promise<{ base64: string; mimeType: string } | null> {
  try {
    const res = await withFeishuHardTimeout(
      getClient()!.im.messageResource.get({
        path: {
          message_id: messageId,
          file_key: fileKey,
        },
        params: {
          type: 'image',
        },
      }),
      FEISHU_RESOURCE_REQUEST_TIMEOUT_MS,
      'Feishu image resource request',
    );

    const stream = res.getReadableStream() as FeishuResourceStream;
    const buffer = await readFeishuResourceBuffer(stream, {
      maxBytes: MAX_FILE_SIZE,
      resourceLabel: `Feishu image ${fileKey}`,
    });
    if (buffer.length === 0) {
      logger.warn({ messageId, fileKey }, 'Empty response from image download');
      return null;
    }

    const mimeType = detectImageMimeType(buffer);
    return {
      base64: buffer.toString('base64'),
      mimeType,
    };
  } catch (err) {
    logger.warn({ err, messageId, fileKey }, 'Failed to download Feishu image');
    return null;
  }
}

/**
 * 下载飞书文件（type='file'）到工作区磁盘。
 * 返回工作区相对路径（如 downloads/feishu/2026-03-01/report.pdf），失败返回 null。
 */
export async function downloadFeishuFileToDisk(
  getClient: () => lark.Client | null,
  messageId: string,
  fileKey: string,
  filename: string,
  groupFolder: string,
): Promise<string | null> {
  try {
    const res = await withFeishuHardTimeout(
      getClient()!.im.messageResource.get({
        path: {
          message_id: messageId,
          file_key: fileKey,
        },
        params: {
          type: 'file',
        },
      }),
      FEISHU_RESOURCE_REQUEST_TIMEOUT_MS,
      'Feishu file resource request',
    );

    const stream = res.getReadableStream() as FeishuResourceStream;
    const buffer = await readFeishuResourceBuffer(stream, {
      maxBytes: MAX_FILE_SIZE,
      resourceLabel: filename || `Feishu file ${fileKey}`,
    });
    if (buffer.length === 0) {
      logger.warn({ messageId, fileKey }, 'Empty response from file download');
      return null;
    }

    const effectiveName = filename || `file_${fileKey}`;
    try {
      const relPath = await saveDownloadedFile(
        groupFolder,
        'feishu',
        effectiveName,
        buffer,
      );
      return relPath;
    } catch (err) {
      if (err instanceof FileTooLargeError) {
        logger.warn({ fileKey, filename }, 'Feishu file too large, skipping');
        return null;
      }
      throw err;
    }
  } catch (err) {
    logger.warn(
      { err, messageId, fileKey },
      'Failed to download Feishu file to disk',
    );
    return null;
  }
}
