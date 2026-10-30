#!/usr/bin/env node
// CKQClaw commit-msg 门禁（任务 L 批次 2，宪法第 8 条的机审化）。
//
// 规则：提交首行必须为 `type: 范围 - 摘要`——
//   - type ∈ 宪法第 8 条白名单（小写）；
//   - 冒号后至少一个空格（house style）；
//   - 「 - 」分隔范围与摘要，两者非空（首个「 - 」为分隔点）；
//   - 仅校验首行，正文自由。
// git 自动生成消息豁免：Merge / Revert "…" / fixup! / squash!。
//
// 由 .githooks/commit-msg 调起（安装见 scripts/install-githooks.mjs）；
// 亦可手动执行：node scripts/gate-commit-msg.mjs <msgfile>。
// hooks 只是第二道防线——verify（npm run verify）仍是唯一强制门禁。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const COMMIT_TYPES = [
  'feat',
  'fix',
  'docs',
  'chore',
  'refactor',
  'test',
  'perf',
  'build',
  'ci',
  'style',
  'revert',
];

export const COMMIT_MSG_PATTERN = new RegExp(
  `^(?:${COMMIT_TYPES.join('|')}): (\\S.*?\\S|\\S) - (\\S.*)$`,
);

export const COMMIT_MSG_EXEMPT_PATTERNS = [
  /^Merge (?:branch|remote-tracking branch|tag|pull request)/,
  /^Revert "/,
  /^(?:fixup|squash)! /,
];

export function validateCommitMessage(message) {
  const subject = String(message).split('\n')[0].replace(/\r$/, '').trim();
  if (!subject) {
    return { ok: false, reason: '首行为空' };
  }
  if (COMMIT_MSG_EXEMPT_PATTERNS.some((pattern) => pattern.test(subject))) {
    return { ok: true };
  }
  if (!COMMIT_MSG_PATTERN.test(subject)) {
    const typeOk = /^[a-z]+: /.test(subject);
    const reason = !typeOk
      ? '缺少 `type: ` 前缀或 type 不在白名单'
      : !subject.includes(' - ')
        ? '缺少「 - 」分隔（house style：`type: 范围 - 摘要`）'
        : '范围或摘要为空';
    return { ok: false, reason };
  }
  return { ok: true };
}

const USAGE_EXAMPLES = `正确示例（宪法第 8 条 + AGENTS.md house style）：
  feat: 工作区 - 新增导出入口
  fix: 调度器 - 修复 missed 任务重复补跑
  docs: 交接 - 任务L批次2执行记录
type 白名单：${COMMIT_TYPES.join(' | ')}

git 自动生成消息（Merge / Revert "…" / fixup!）自动豁免。`;

function main(argv) {
  const messageFile = argv[2];
  if (!messageFile) {
    console.error('gate-commit-msg: 缺参数（应为 commit message 文件路径）');
    process.exit(2);
  }
  const message = fs.readFileSync(messageFile, 'utf8');
  const result = validateCommitMessage(message);
  if (!result.ok) {
    console.error(`✘ commit message 不合规：${result.reason}`);
    console.error(`  首行：${message.split('\n')[0].trim()}`);
    console.error(USAGE_EXAMPLES);
    process.exit(1);
  }
  process.exit(0);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv);
}
