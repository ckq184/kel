import fs from 'fs';
import path from 'path';
import { GROUPS_DIR, MAX_FILE_SIZE } from './config.js';
import { extractFileText } from './file-text-extractor.js';

// MAX_FILE_SIZE 统一由 config.ts 定义（可通过 MAX_FILE_SIZE_MB 环境变量配置），
// 此处 re-export 保持既有 import 路径不变。IM 渠道收文件与 Web 上传共用此上限。
export { MAX_FILE_SIZE };

export class FileTooLargeError extends Error {
  constructor(filename: string, size: number) {
    super(
      `File "${filename}" is too large: ${size} bytes (max ${MAX_FILE_SIZE} bytes)`,
    );
    this.name = 'FileTooLargeError';
  }
}

/**
 * 清洗来自 IM 渠道的文件名，剥离用于 prompt 注入的字符。`path.basename` 不
 * 剥离这些字符，所以仅依赖它会把攻击载荷透传到 Agent prompt。
 *
 * 行为：
 * - 始终先 path.basename 剥离目录部分。
 * - 控制字符替换为空格：ASCII C0+DEL（含 \n/\r/\t）、C1（U+0080-U+009F）、
 *   行/段分隔符（U+2028/U+2029）、bidi 控制（U+200E/U+200F/U+202A-U+202E/
 *   U+2066-U+2069）、零宽（U+200B-U+200D）、word joiner（U+2060）、
 *   interlinear annotation（U+FFF9-U+FFFB）、BOM/U+FEFF。
 * - 反引号 / box-drawing（U+2500-U+257F 整段）替换为空格。
 * - 半角 + 全角中括号转空格（防 `[文件: …]` 围栏被攻破）。
 * - 折叠空白，截断到 200 字符；空字符串回落 `unnamed`。
 */
export function sanitizeImFilename(raw: string | undefined | null): string {
  const base = path.basename(String(raw ?? '')).trim();
  if (!base) return 'unnamed';
  const cleaned = base
    // C0 + DEL + C1 + 行段分隔 + bidi + 零宽 + 其他
    .replace(
      /[\x00-\x1f\x7f-\x9f\u00ad\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff\ufff9-\ufffb]/g,
      ' ',
    )
    // box-drawing 整段
    .replace(/[\u2500-\u257f]+/g, ' ')
    // 反引号
    .replace(/`+/g, ' ')
    // 半角 + 全角中括号
    .replace(/[\[\]\uff3b\uff3d]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'unnamed';
  return cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned;
}

/**
 * 将 Buffer 写入 downloads/{channel}/{YYYY-MM-DD}/ 目录，
 * 返回工作区相对路径（如 downloads/feishu/2026-03-01/report.pdf）。
 * @throws FileTooLargeError 当 buffer.length > MAX_FILE_SIZE
 */
export async function saveDownloadedFile(
  groupFolder: string,
  channel: 'feishu' | 'qq' | 'wechat',
  originalFilename: string,
  buffer: Buffer,
): Promise<string> {
  if (buffer.length > MAX_FILE_SIZE) {
    throw new FileTooLargeError(originalFilename, buffer.length);
  }

  const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dir = path.join(GROUPS_DIR, groupFolder, 'downloads', channel, dateStr);
  fs.mkdirSync(dir, { recursive: true });

  // 同时清洗控制字符：returned relPath 会被插入 agent prompt，
  // 不能保留 \n / 反引号等可被滥用的字符。sanitize 失败 fallback 时
  // 用时间戳重命名，避免和合法叫 "unnamed" 的文件冲突。
  let safeName = sanitizeImFilename(originalFilename);
  if (safeName === 'unnamed') {
    safeName = `file_${Date.now()}`;
  }

  // 冲突处理：原方案只用 _HHmmss 后缀，同秒并发会让两个并发写入指向同一
  // 后缀名互相覆盖。改为 while 循环递增 -2 / -3 / ... 保证每次都拿到独立
  // 文件名。`fs.openSync(absPath, 'wx')` 仍可能竞速，但两端命名不同时它能
  // 把同名冲突显式抛出来，不再静默覆写。
  let absPath = path.join(dir, safeName);
  if (fs.existsSync(absPath)) {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const baseSuffix = `_${hh}${mm}${ss}`;
    const ext = path.extname(safeName);
    const baseName = path.basename(safeName, ext);
    let i = 0;
    while (true) {
      const tail = i === 0 ? baseSuffix : `${baseSuffix}_${i}`;
      safeName = `${baseName}${tail}${ext}`;
      absPath = path.join(dir, safeName);
      if (!fs.existsSync(absPath)) break;
      i++;
      if (i > 1000) {
        // 极端兜底：上千次同秒同名几乎不可能，但避免死循环。
        safeName = `${baseName}${baseSuffix}_${Date.now()}${ext}`;
        absPath = path.join(dir, safeName);
        break;
      }
    }
  }

  // 用 'wx' 标志原子创建：仍有 race（两个进程同时拿到 doesn't-exist 后都
  // 创建），用 wx 让冲突方收到 EEXIST 而不是悄悄覆写；外层 catch 会回到
  // 路由层的错误处理（IM media 一般会触发重试机制）。
  let fd: number;
  try {
    fd = fs.openSync(
      absPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o644,
    );
  } catch (err: any) {
    if (err && err.code === 'EEXIST') {
      // 极端竞态：另一进程刚刚抢占同名。再换一次后缀重试。
      safeName = `${path.basename(safeName, path.extname(safeName))}_${Date.now()}${path.extname(safeName)}`;
      absPath = path.join(dir, safeName);
      fd = fs.openSync(
        absPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o644,
      );
    } else {
      throw err;
    }
  }
  try {
    fs.writeFileSync(fd, buffer);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }

  // 返回相对于群组工作区根目录的路径
  const groupRoot = path.join(GROUPS_DIR, groupFolder);
  return path.relative(groupRoot, absPath).replace(/\\/g, '/');
}

/**
 * 依据内容自适应地选取包裹抽取文本的反引号围栏：围栏长度必须严格大于
 * 内容中最长的反引号连续串（至少 3 个）。否则攻击者可在文件内容里预埋
 * ``` 提前闭合围栏，把后续文本伪装成新指令；长度随内容变化，无法预知。
 */
function pickContentFence(text: string): string {
  let longest = 2;
  for (const run of text.match(/`+/g) ?? []) {
    longest = Math.max(longest, run.length);
  }
  return '`'.repeat(longest + 1);
}

/**
 * 把已落盘的入站文件内容内联进消息文本（弱模型兜底）。
 *
 * 动机：弱模型（MiniMax 等）不会可靠地调用 Read 读文件、甚至会从会话缓存
 * 幻觉，所以把抽取文本直接内联进 prompt（原钉钉渠道模式，渠道删除后该
 * 能力由三渠道共用）。
 *
 * 输入：`relPath` 为与消息里 `[文件: relPath]` 标记一致的工作区相对路径
 * （通常来自 saveDownloadedFile 的返回值）。
 *
 * 返回：抽取成功 → `[文件: relPath]` + 换行 + 自适应围栏包裹的抽取文本
 * （20KB 截断由 extractor 负责，截断标记随文本内联）；抽取失败 / 扩展名
 * 不支持 / 文件缺失 / relPath 逃逸工作区 → null，调用方维持仅路径标记。
 */
export async function buildInlinedFileContent(
  groupFolder: string,
  relPath: string,
): Promise<string | null> {
  const groupRoot = path.join(GROUPS_DIR, groupFolder);
  const absPath = path.join(groupRoot, relPath);
  // relPath 实际来自 saveDownloadedFile 的返回值，但防御性校验避免路径
  // 穿越把任意磁盘文件读进 prompt。
  if (!absPath.startsWith(groupRoot + path.sep)) return null;

  const extracted = await extractFileText(absPath);
  if (!extracted) return null;

  const fence = pickContentFence(extracted.text);
  return `[文件: ${relPath}]\n${fence}\n${extracted.text}\n${fence}`;
}
