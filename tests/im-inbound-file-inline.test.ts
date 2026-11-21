import { afterAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { removeTmpDirRecursive } from './helpers/remove-tmp-dir.js';

// im-downloader 经 config.js 取 GROUPS_DIR；指向临时目录避免污染 data/。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'im-inbound-inline-'));
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  ASSISTANT_NAME: 'CKQClaw',
  DATA_DIR: tmpDir,
  GROUPS_DIR: tmpGroupsDir,
  MAX_FILE_SIZE: 20 * 1024 * 1024,
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

// vi.mock 工厂在模块首次 import 时才执行，动态 import 保证 tmpDir 已就绪。
const { saveDownloadedFile, buildInlinedFileContent } =
  await import('../src/im-downloader.js');

afterAll(() => {
  removeTmpDirRecursive(tmpDir);
});

/** 从内联结果中提取纯围栏行（仅由反引号组成的行）。 */
function fenceLines(inlined: string): string[] {
  return inlined.split('\n').filter((line) => /^`+$/.test(line));
}

/** 围栏行之外的任意反引号连续串的最大长度（用于验证围栏严格更长）。 */
function longestBacktickRun(text: string): number {
  return Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
}

describe('buildInlinedFileContent（入站文件文本内联 helper）', () => {
  test('抽取成功：返回 [文件: 路径] 标记 + 围栏包裹的全文', async () => {
    const relPath = await saveDownloadedFile(
      'group-a',
      'feishu',
      'notes.md',
      Buffer.from('# 标题\n正文内容'),
    );
    const out = await buildInlinedFileContent('group-a', relPath);
    expect(out).not.toBeNull();
    const lines = out!.split('\n');
    // 首行为与既有 [文件: ] 标记一致的路径引用
    expect(lines[0]).toBe(`[文件: ${relPath}]`);
    // 标准三反引号围栏开/闭，内容完整保留在围栏内
    expect(lines[1]).toBe('```');
    expect(lines[lines.length - 1]).toBe('```');
    expect(out!).toContain('# 标题');
    expect(out!).toContain('正文内容');
  });

  test('内容含 ``` 时围栏加长，内容无法提前闭合围栏', async () => {
    const body = '代码示例：\n```js\nconsole.log(1);\n```\n尾行';
    const relPath = await saveDownloadedFile(
      'group-a',
      'qq',
      'snippet.md',
      Buffer.from(body),
    );
    const out = await buildInlinedFileContent('group-a', relPath);
    expect(out).not.toBeNull();
    const fences = fenceLines(out!);
    expect(fences.length).toBeGreaterThanOrEqual(2);
    // 围栏严格长于内容里最长的反引号串（内容含 ``` → 围栏 > 3）
    const fenceLen = fences[0]!.length;
    expect(fenceLen).toBeGreaterThan(longestBacktickRun(body));
    expect(fenceLen).toBeGreaterThan(3);
    // 开/闭围栏一致
    expect(fences[0]).toBe(fences[fences.length - 1]);
  });

  test('不支持扩展名 → null（调用方维持仅路径标记）', async () => {
    const relPath = await saveDownloadedFile(
      'group-a',
      'wechat',
      'blob.bin',
      Buffer.from([0, 1, 2, 3]),
    );
    expect(await buildInlinedFileContent('group-a', relPath)).toBeNull();
  });

  test('抽取失败（junk pdf）→ null', async () => {
    const relPath = await saveDownloadedFile(
      'group-a',
      'feishu',
      'junk.pdf',
      Buffer.from('NOT A PDF'),
    );
    expect(await buildInlinedFileContent('group-a', relPath)).toBeNull();
  });

  test('文件缺失 → null', async () => {
    expect(
      await buildInlinedFileContent(
        'group-a',
        'downloads/feishu/2026-01-01/ghost.md',
      ),
    ).toBeNull();
  });

  test('relPath 逃逸群组工作区 → null（防路径穿越读取任意文件）', async () => {
    expect(
      await buildInlinedFileContent('group-a', '../../escape.md'),
    ).toBeNull();
    expect(await buildInlinedFileContent('group-a', '/etc/passwd')).toBeNull();
  });

  test('超 20KB 文本被 extractor 截断，截断标记随围栏内联', async () => {
    const relPath = await saveDownloadedFile(
      'group-a',
      'qq',
      'big.txt',
      Buffer.from('a'.repeat(50 * 1024)),
    );
    const out = await buildInlinedFileContent('group-a', relPath);
    expect(out).not.toBeNull();
    expect(out!).toContain('[...内容过长已截断');
    // 截断标记必须落在围栏内部（围栏行本身不含该标记）
    const fences = fenceLines(out!);
    const inner = out!.slice(
      out!.indexOf(fences[0]!) + fences[0]!.length,
      out!.lastIndexOf(fences[fences.length - 1]!),
    );
    expect(inner).toContain('[...内容过长已截断');
  });
});

describe('三渠道入站文件内联接线（源码契约）', () => {
  const channels = [
    {
      // ISSUE-12 单元 2.9：飞书入站文件内联接线随附件段自 src/feishu.ts
      // 原文搬至 src/feishu-inbound-attachments.ts，本条三断言（im-downloader
      // import / (groupFolder, relPath) 调用形 / ?? 回退）等强改锚新模块，
      // 断言文本逐字不变，仅锚点文件随搬运体搬家。
      file: 'src/feishu-inbound-attachments.ts',
      call: 'buildInlinedFileContent(groupFolder, relPath)',
    },
    {
      file: 'src/qq.ts',
      call: 'buildInlinedFileContent(groupFolder, relPath)',
    },
    {
      file: 'src/wechat.ts',
      call: 'buildInlinedFileContent(groupFolder, result.savedPath)',
    },
  ] as const;

  test('三渠道均 import 共享 helper 并以落盘相对路径调用', () => {
    for (const { file, call } of channels) {
      const source = fs.readFileSync(file, 'utf8');
      // import 自 im-downloader（与其他下载基建同源）
      expect(source).toMatch(
        /import\s*\{[^}]*buildInlinedFileContent[^}]*\}\s*from\s*'\.\/im-downloader\.js'/,
      );
      // 以（groupFolder, 相对路径）实参调用，路径与 [文件: ] 标记同源
      expect(source).toContain(call);
    }
  });

  test('抽取失败时三渠道回退仅路径标记 [文件: …]（?? 空值合并）', () => {
    for (const { file } of channels) {
      const source = fs.readFileSync(file, 'utf8');
      // ?? 与回退模板之间允许换行（prettier 行宽折行）
      expect(source).toMatch(/\?\?\s*`\[文件: \$\{/);
    }
  });
});
