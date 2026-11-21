/**
 * 飞书入站附件下载与正文内联引用替换（原 createFeishuConnection 工厂内
 * processClaimedIncomingMessage 主管道附件段，ISSUE-12 单元 2.9 原文搬运）。
 *
 * 段位前提：本函数只由主管道在消息通过受众门 / mention 门 / 路由准入与
 * 内容 enrich 之后于原位置调用——未授权发送者 / 未 @bot 的群消息在那之前
 * 已 return，绝不会触发图片/文件下载落盘或对飞书 API 的拉取（防止未授权
 * 资源消耗 / SSRF 式拉取）。该顺序契约由
 * tests/channel-route-side-effect-order.test.ts 锚定管道侧委托调用形。
 *
 * 搬运体逐字节保留，唯一机械替换为闭包引用 () => client → 显式 getClient
 * （3 处下载调用）。段内无 claim 终态调用与管道提前出口：唯一 return 是
 * replaceReferenceMarker 箭头函数守卫（原 claim 生命周期表 nested 行，随本
 * 单元同提交改锚 tests/feishu-inbox-claim-lifecycle.test.ts）；下载/落盘
 * 失败一律 logger.warn 后继续，其余异常上抛由主管道 intake catch 兜底重试。
 *
 * 三下游变量经结果对象回接主管道原下游名：text（图片/文件标记与内联替换后
 * 的正文）、attachmentsJson（Vision 附件 JSON）、referencedMessages（引用
 * 消息副本，标记替换后由主管道 channelContext 消费）。
 */
import type * as lark from '@larksuiteoapi/node-sdk';
import { logger } from './logger.js';
import {
  saveDownloadedFile,
  sanitizeImFilename,
  buildInlinedFileContent,
} from './im-downloader.js';
import {
  downloadFeishuFileToDisk,
  downloadFeishuImage,
} from './feishu-media.js';
import type { ChannelReferencedMessage } from './types.js';

/**
 * extractMessageContent 产出的文件信息形状。src/feishu.ts 的 FeishuFileInfo
 * 接口未导出（本单元不得扩宽 feishu.ts 导出面），此处按搬运体实际消费的
 * 字段结构重述；成员逐字一致，调用侧整对象传入结构兼容。
 */
export interface FeishuInboundFileInfo {
  fileKey: string;
  filename: string;
}

/**
 * feishu-rich-content 的 EnrichedFeishuInboundContent 未导出（该文件本单元
 * 不得触碰），按搬运体实际消费的三个可选字段做结构收窄；成员形状与该接口
 * 逐字一致，调用侧整对象传入结构兼容。
 */
export interface FeishuInboundEnrichedRefs {
  currentImageRefs?: Array<{
    messageId: string;
    imageKey: string;
  }>;
  referencedImageRefs?: Array<{
    messageId: string;
    referenceMessageId: string;
    imageKey: string;
    marker: string;
  }>;
  references?: Array<{
    id: string;
    sender?: string;
    text: string;
    attachmentHints?: string[];
  }>;
}

/** 附件段搬运体的消息侧入参。 */
export interface FeishuInboundAttachmentRefs {
  /** 当前消息 id（飞书 messageResource API 的资源属主）。 */
  messageId: string;
  /** 聊天 JID（resolveGroupFolder 落盘目录解析键）。 */
  chatJid: string;
  /** 消息类型（文件下载日志沿用原字段）。 */
  messageType: string;
  /** extractMessageContent 解析结果（当前消息图片键与文件信息）。 */
  extracted: {
    imageKeys?: string[];
    fileInfos?: FeishuInboundFileInfo[];
  };
  /** enrichFeishuInboundContent 回传（引用图片与引用消息）。 */
  enriched: FeishuInboundEnrichedRefs;
}

/** 附件段搬运体的连接回调与可变正文入参。 */
export interface FeishuInboundAttachmentOpts {
  /** ConnectOptions.resolveGroupFolder 回调（工作区落盘目录；缺省只走占位符通道）。 */
  resolveGroupFolder?: (chatJid: string) => string | undefined;
  /** 门控与 enrich 之后的正文文本；段内追加图片/文件标记后随结果回传。 */
  text: string;
}

/** 附件段结果：沿主管道原下游变量名回接。 */
export interface FeishuInboundAttachmentResult {
  /** 追加图片/文件标记与内联替换后的正文。 */
  text: string;
  /** Vision 附件 JSON（无可视附件时为 undefined）。 */
  attachmentsJson: string | undefined;
  /** 引用消息副本（标记替换后由主管道 channelContext 消费）。 */
  referencedMessages: ChannelReferencedMessage[];
}

/**
 * 白名单后附件段：当前消息图片双轨下载（Vision base64 + 工作区落盘）、
 * 引用图片下载与 replaceReferenceMarker 正文/引用替换、文件消息落盘与
 * buildInlinedFileContent 内联（弱模型兜底 ?? 仅路径标记）。原文搬运自
 * src/feishu.ts 的 processClaimedIncomingMessage 附件段。
 */
export async function downloadFeishuInboundAttachments(
  getClient: () => lark.Client | null,
  refs: FeishuInboundAttachmentRefs,
  opts: FeishuInboundAttachmentOpts,
): Promise<FeishuInboundAttachmentResult> {
  const { extracted, enriched, messageId, chatJid, messageType } = refs;
  const { resolveGroupFolder } = opts;
  let text = opts.text;
  let attachmentsJson: string | undefined;

  const currentImageKeys = extracted.imageKeys ?? [];
  const currentImageRefs =
    enriched.currentImageRefs ??
    currentImageKeys.map((imageKey) => ({ messageId, imageKey }));
  const referencedImageRefs = enriched.referencedImageRefs ?? [];
  const referencedMessages: ChannelReferencedMessage[] = (
    enriched.references ?? []
  ).map((reference) => ({ ...reference }));
  const replaceReferenceMarker = (
    referenceMessageId: string,
    marker: string,
    replacement: string,
    attachmentIndex?: number,
  ): void => {
    const reference = referencedMessages.find(
      (item) => item.id === referenceMessageId && item.text.includes(marker),
    );
    if (!reference) return;
    reference.text = reference.text.replace(marker, replacement);
    reference.attachmentHints = [
      ...(reference.attachmentHints ?? []),
      replacement,
    ];
    if (attachmentIndex !== undefined) {
      reference.attachmentIndexes = [
        ...(reference.attachmentIndexes ?? []),
        attachmentIndex,
      ];
    }
  };
  if (currentImageRefs.length > 0 || referencedImageRefs.length > 0) {
    // 图片消息：下载后双轨处理
    // 1. Vision 通道：base64 附件供模型看图
    // 2. 存盘通道：写入工作区文件，agent 可直接操作（压缩、发送等）
    const attachments = [];
    const groupFolder = resolveGroupFolder?.(chatJid);
    const savedPaths: string[] = [];
    let downloadedCurrentImages = 0;

    for (const imageRef of currentImageRefs) {
      const { imageKey } = imageRef;
      const imageData = await downloadFeishuImage(
        getClient,
        imageRef.messageId,
        imageKey,
      );
      if (!imageData) continue;
      downloadedCurrentImages++;

      // Vision 附件
      attachments.push({
        type: 'image',
        data: imageData.base64,
        mimeType: imageData.mimeType,
      });

      // 存盘：扩展名从 mimeType 推断，对齐文件消息处理逻辑
      if (groupFolder) {
        const extMap: Record<string, string> = {
          'image/jpeg': '.jpg',
          'image/png': '.png',
          'image/gif': '.gif',
          'image/webp': '.webp',
          'image/bmp': '.bmp',
          'image/tiff': '.tiff',
        };
        const ext = extMap[imageData.mimeType] ?? '.jpg';
        const fileName = `feishu_img_${imageKey.slice(-8)}${ext}`;
        try {
          const relPath = await saveDownloadedFile(
            groupFolder,
            'feishu',
            fileName,
            Buffer.from(imageData.base64, 'base64'),
          );
          if (relPath) savedPaths.push(relPath);
        } catch (err) {
          logger.warn({ err, imageKey }, 'Failed to save Feishu image to disk');
        }
      }
    }

    // Referenced images must be downloaded against the message that owns
    // the image key, not the current event. The normalized text carries a
    // stable marker so the saved path stays associated with the correct
    // quoted message while the same bytes are also supplied to vision.
    for (const ref of referencedImageRefs) {
      const imageData = await downloadFeishuImage(
        getClient,
        ref.messageId,
        ref.imageKey,
      );
      if (!imageData) {
        replaceReferenceMarker(
          ref.referenceMessageId,
          ref.marker,
          '[引用图片下载失败]',
        );
        continue;
      }
      const attachmentIndex = attachments.length;
      attachments.push({
        type: 'image',
        data: imageData.base64,
        mimeType: imageData.mimeType,
      });
      let replacement = '[引用图片]';
      if (groupFolder) {
        const extMap: Record<string, string> = {
          'image/jpeg': '.jpg',
          'image/png': '.png',
          'image/gif': '.gif',
          'image/webp': '.webp',
          'image/bmp': '.bmp',
          'image/tiff': '.tiff',
        };
        const ext = extMap[imageData.mimeType] ?? '.jpg';
        const fileName = `feishu_ref_${ref.imageKey.slice(-8)}${ext}`;
        try {
          const relPath = await saveDownloadedFile(
            groupFolder,
            'feishu',
            fileName,
            Buffer.from(imageData.base64, 'base64'),
          );
          if (relPath) replacement = `[引用图片: ${relPath}]`;
        } catch (err) {
          logger.warn(
            { err, messageId: ref.messageId, imageKey: ref.imageKey },
            'Failed to save referenced Feishu image to disk',
          );
        }
      }
      replaceReferenceMarker(
        ref.referenceMessageId,
        ref.marker,
        replacement,
        attachmentIndex,
      );
    }

    // 拼接图片标记：成功下载的用路径，失败的用占位符，确保 text 不为空。
    // 否则长图/超大图片下载失败时会落入 agent 的空消息分支，回复"消息是空的"。
    const failedCount = currentImageRefs.length - downloadedCurrentImages;
    const markers: string[] = [];
    if (attachments.length > 0) {
      attachmentsJson = JSON.stringify(attachments);
    }
    if (downloadedCurrentImages > 0) {
      if (savedPaths.length > 0) {
        markers.push(...savedPaths.map((p) => `[图片: ${p}]`));
      } else {
        markers.push('[图片]');
      }
    }
    if (failedCount > 0) {
      markers.push(
        `[图片下载失败: ${failedCount} 张，可能超过飞书接口限制或网络异常]`,
      );
      logger.warn(
        {
          chatJid,
          messageId,
          failedCount,
          totalKeys: currentImageRefs.length,
        },
        'Feishu image download failed for some or all images',
      );
    }
    const imgMarker = markers.join('\n');
    if (imgMarker) {
      text = text ? `${imgMarker}\n${text}` : imgMarker;
    }
  }
  if (extracted.fileInfos && extracted.fileInfos.length > 0) {
    // 文件消息：下载到磁盘，路径内联替换
    logger.info(
      {
        chatJid,
        messageId,
        messageType,
        fileCount: extracted.fileInfos.length,
      },
      'Processing Feishu file download',
    );
    const groupFolder = resolveGroupFolder?.(chatJid);
    if (!groupFolder) {
      logger.warn({ chatJid }, 'Cannot resolve group folder for file download');
      for (const fi of extracted.fileInfos) {
        const safeFilename = sanitizeImFilename(fi.filename || fi.fileKey);
        const placeholder = `[文件: ${safeFilename}]`;
        text = text.replace(placeholder, `[文件下载失败: ${safeFilename}]`);
      }
    } else {
      for (const fi of extracted.fileInfos) {
        const safeFilename = sanitizeImFilename(fi.filename || fi.fileKey);
        const relPath = await downloadFeishuFileToDisk(
          getClient,
          messageId,
          fi.fileKey,
          fi.filename,
          groupFolder,
        );
        const placeholder = `[文件: ${safeFilename}]`;
        // 弱模型兜底：抽取成功则内联文件文本，失败回退仅路径标记。
        const replacement = !relPath
          ? `[文件下载失败: ${safeFilename}]`
          : ((await buildInlinedFileContent(groupFolder, relPath)) ??
            `[文件: ${relPath}]`);
        // replacer 用函数形式：replacement 含文件抽取文本，其中的
        // $& / $' 等特殊序列不能被 String.replace 展开。
        text = text.replace(placeholder, () => replacement);
      }
    }
  }
  return { text, attachmentsJson, referencedMessages };
}
