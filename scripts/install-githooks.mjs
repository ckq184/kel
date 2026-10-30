#!/usr/bin/env node
// 安装 CKQClaw git hooks（任务 L 批次 2，经用户按宪法第 6 条显式批准引入）。
//
// 做三件事（幂等，重复运行无害）：
//   1. git config core.hooksPath .githooks —— 不写 .git/hooks，检出即可用；
//   2. 把 .githooks/* 的 CRLF 归一为 LF（兜底）：`.gitattributes` 已按任务 N
//      轻量裁决锁定 `.githooks/*` 与 `*.sh` 检出为 LF，本步处理规则落地前
//      已存在的 CRLF 工作区副本（CRLF 会破坏 sh 的 shebang 与命令行）；
//   3. POSIX 下补 chmod 755（Windows 忽略）。
//
// 定位宣示：hooks 只是第二道防线——verify（npm run verify）仍是唯一强制
// 门禁；hooks 被绕过不产生虚假安全感。禁止 git commit --no-verify。
//
// 用法：node scripts/install-githooks.mjs（在仓库内任意目录执行均可）

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

let repoRoot;
try {
  repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
} catch {
  console.error('install-githooks: 不在 git 仓库内。');
  process.exit(1);
}

const hooksDir = path.join(repoRoot, '.githooks');
if (!fs.existsSync(hooksDir) || !fs.statSync(hooksDir).isDirectory()) {
  console.error(`install-githooks: 仓库内无 .githooks 目录（${hooksDir}）。`);
  process.exit(1);
}

execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
  cwd: repoRoot,
});

const normalized = [];
for (const entry of fs.readdirSync(hooksDir, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const file = path.join(hooksDir, entry.name);
  const content = fs.readFileSync(file, 'utf8');
  if (content.includes('\r')) {
    fs.writeFileSync(file, content.replace(/\r\n/g, '\n'));
    normalized.push(entry.name);
  }
  try {
    fs.chmodSync(file, 0o755);
  } catch {
    // Windows 文件系统无 POSIX 执行位概念，忽略
  }
}

console.log('✓ git hooks 已启用（core.hooksPath=.githooks）：');
for (const name of fs.readdirSync(hooksDir)) {
  console.log(`    - ${name}`);
}
if (normalized.length > 0) {
  console.log(
    `✓ 已把 ${normalized.length} 个 hook 的 CRLF 归一为 LF：${normalized.join(', ')}`,
  );
}
console.log(
  '提醒：hooks 是第二道防线，verify（npm run verify）仍是唯一强制门禁；\n' +
    '禁止 git commit --no-verify 绕过。',
);
