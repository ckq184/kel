#!/usr/bin/env node
// CKQClaw pre-commit 门禁（任务 L 批次 2，宪法第 3 条敏感信息的机审化第一道）。
//
// 两段检查，秒级完成：
//   1. secret 扫描：只扫暂存区新增行（git diff --cached -U0 的 + 行），
//      模式真相源 = 仓库现有 redact 实现（container/agent-runner/src/utils.ts
//      的 redactInlineSecrets 厂商前缀集 + src/routes/bug-report.ts 的
//      Bearer/Basic/JWT/键值对泛化集），检测侧做了提交场景的误报收敛：
//      - 全部厂商前缀保留 \b 边界（「task-k-…」这类路径词不误伤）；
//      - 键值对赋值只对「带引号 ≥8 字符」或「无引号 ≥12 字符且字母数字
//        混排」的值告警；process.env 引用与占位符（*** / <your-key> 之类）豁免
//        ——`password: string` 这类类型注解不得被拦。
//      命中输出只含 文件:行号 + 模式 id，绝不回显命中内容（涉密日志红线）。
//   2. 改动文件格式检查：复用 scripts/check-format-changed.mjs（check 模式）。
//
// 豁免机制：仓库根 .gatesecretsignore（每行一个路径模式；# 注释；
// * 单段通配、** 跨段通配，相对仓库根）。**只允许假 key fixture 入白名单**，
// 真实密钥的正确处置是撤销轮换，不是加白。
//
// 由 .githooks/pre-commit 调起（安装见 scripts/install-githooks.mjs）。
// hooks 只是第二道防线——verify（npm run verify）仍是唯一强制门禁。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRepoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

// ─── secret 模式集（真相源见文件头；修改时同步契约测试）──────────────────
const SENSITIVE_KEY_VALUE =
  /(\b\w*(?:token|password|passwd|secret|api[_-]?key|auth[_-]?token|authorization|cookie|credential|private[_-]?key|access[_-]?key|app[_-]?secret)\w*)["']?\s*[=:]\s*("[^"\n]*"?|'[^'\n]*'?|[^\s"']+)/gi;

export const SECRET_PATTERNS = [
  { id: 'vendor-prefix-sk', test: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/ },
  {
    id: 'vendor-prefix-github',
    test: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  },
  { id: 'vendor-prefix-github-pat', test: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { id: 'vendor-prefix-gitlab', test: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { id: 'vendor-prefix-slack', test: /\bxox[abeprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'vendor-prefix-aws', test: /\b(?:AKIA|ASIA)[0-9A-Z]{12,20}\b/ },
  { id: 'vendor-prefix-google', test: /\bAIza[0-9A-Za-z_-]{35}/ },
  { id: 'vendor-prefix-stripe', test: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}/ },
  {
    id: 'vendor-prefix-sendgrid',
    test: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/,
  },
  { id: 'vendor-prefix-npm', test: /\bnpm_[A-Za-z0-9]{30,}/ },
  {
    id: 'private-key-block',
    test: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  {
    id: 'auth-scheme',
    test: /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/i,
  },
  {
    id: 'jwt',
    test: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/,
  },
  {
    id: 'url-userinfo',
    test: /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s/:@]+:[^\s@/?#]+@/i,
  },
  { id: 'sensitive-assignment', test: SENSITIVE_KEY_VALUE, custom: true },
];

const PATTERN_DESCRIPTIONS = {
  'vendor-prefix-sk': 'OpenAI/Anthropic 风格 sk- 前缀密钥',
  'vendor-prefix-github': 'GitHub token（ghp_/gho_/ghu_/ghs_/ghr_）',
  'vendor-prefix-github-pat': 'GitHub fine-grained PAT',
  'vendor-prefix-gitlab': 'GitLab token（glpat-）',
  'vendor-prefix-slack': 'Slack token（xox?）',
  'vendor-prefix-aws': 'AWS AccessKeyId（AKIA/ASIA）',
  'vendor-prefix-google': 'Google API key（AIza）',
  'vendor-prefix-stripe': 'Stripe 密钥（sk_live_/sk_test_）',
  'vendor-prefix-sendgrid': 'SendGrid API key（SG.）',
  'vendor-prefix-npm': 'npm token（npm_）',
  'private-key-block': 'PEM 私钥块',
  'auth-scheme': 'Bearer/Basic 凭据头',
  jwt: 'JWT（eyJ 三段）',
  'url-userinfo': 'URL 内嵌账号密码（scheme://user:pass@）',
  'sensitive-assignment': '敏感键名赋值（token/secret/password/api_key 等）',
};

const PLACEHOLDER_VALUE =
  /^(?:\*+|x+|\.{2,}|<[^>]*>|\[[^\]]*\]|change_?me(?:_please)?|redacted|your[_-].*|example.*)$/i;

// 提交场景的误报收敛（批次 2 两轮全库扫描定型，配套回归测试防漂移）：
//   - 含代码元字符（括号/方括号/花括号/反引号/$/^/|/?/*/反斜杠）的值是代码
//     或模板字面量——凭据字符集（base62/base64/hex/JWT）不含这些（base64 的
//     +、/、= 特意不在屏蔽集内，base64 密钥仍可命中）；
//   - URL 形态的值跳过（内嵌凭据的 URL 由 url-userinfo 模式单独覆盖）；
//   - process.* 引用（argv/env）与点路径标识符（v3.officialSecrets.x）是代码；
//   - 值必须字母数字混排且达最小长度：真实凭据几乎必然混排，而
//     `__Host-ckqclaw_session` 常量名、`password: string` 类型注解不混排；
//   - 占位符（*** / <your-key> / example… 等）豁免。
function sensitiveAssignmentHits(line) {
  const hits = [];
  for (const match of line.matchAll(SENSITIVE_KEY_VALUE)) {
    const raw = match[2] ?? '';
    const quoted = raw.startsWith('"') || raw.startsWith("'");
    let value = quoted ? raw.slice(1).replace(/["']$/, '') : raw;
    if (!value) continue;
    value = value.replace(/[,;]+$/, '');
    if (!value) continue;
    if (PLACEHOLDER_VALUE.test(value)) continue;
    if (/^process\./.test(value)) continue;
    if (/[\[\]{}()`$^*+?|\\]/.test(value)) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) continue;
    if (/^[A-Za-z_$][\w$]*(?:\.[\w$]+)+$/.test(value)) continue;
    const mixed = /[A-Za-z]/.test(value) && /\d/.test(value);
    const longEnough = quoted ? value.length >= 8 : value.length >= 12;
    if (mixed && longEnough) {
      hits.push({ patternId: 'sensitive-assignment' });
    }
  }
  return hits;
}

// 扫描单段文本，返回命中数组（{ patternId }）。
export function scanText(text) {
  const hits = [];
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.custom) {
      hits.push(...sensitiveAssignmentHits(text));
    } else if (pattern.test.test(text)) {
      hits.push({ patternId: pattern.id });
    }
  }
  return hits;
}

// ─── .gatesecretsignore（路径模式；* 单段、** 跨段）──────────────────────
function globToRegExp(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i += 1;
        if (pattern[i + 1] === '/') i += 1;
      } else {
        source += '[^/]*';
      }
    } else {
      source += ch.replace(/[.*+?^${}()|[\]\\]/, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

export function compileIgnorePatterns(lines) {
  return lines
    .map((line) => line.replace(/\r$/, '').trim())
    .filter((line) => line && !line.startsWith('#'))
    .map(globToRegExp);
}

export function isIgnored(filePath, compiled) {
  return compiled.some((pattern) => pattern.test(filePath));
}

// ─── 暂存 diff 解析（-U0：@@ 头给新侧行号）───────────────────────────────
function unquoteGitPath(raw) {
  if (!raw.startsWith('"')) return raw;
  return raw
    .slice(1, -1)
    .replace(/\\(.)/g, (_, ch) =>
      ch === 'n'
        ? '\n'
        : ch === 't'
          ? '\t'
          : ch === '\\' || ch === '"'
            ? ch
            : '',
    );
}

// 扫描 git diff -U0 输出的 + 行。返回 { path, lineNo, patternId }（不含命中
// 内容本身）。compiled 为 compileIgnorePatterns 的结果。
export function scanAddedLines(diffText, compiled) {
  const violations = [];
  let currentPath = null;
  let newLineNo = 0;
  for (const rawLine of diffText.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('+++ ')) {
      const target = unquoteGitPath(line.slice(4));
      currentPath = target === '/dev/null' ? null : target.replace(/^b\//, '');
      continue;
    }
    if (line.startsWith('@@')) {
      const hunk = line.match(/\+(\d+)(?:,(\d+))?/);
      newLineNo = hunk ? Number(hunk[1]) : 0;
      continue;
    }
    if (currentPath && line.startsWith('+') && !line.startsWith('+++')) {
      const content = line.slice(1);
      if (!isIgnored(currentPath, compiled)) {
        const hits = scanText(content);
        for (const hit of hits) {
          violations.push({ path: currentPath, lineNo: newLineNo, ...hit });
        }
      }
      newLineNo += 1;
    } else if (line.startsWith(' ')) {
      // context 行同样占新侧行号（-U0 实际不产出 context，此处保证解析
      // -U1 及以上 diff 时行号依旧正确）
      newLineNo += 1;
    }
  }
  return violations;
}

// ─── CLI ─────────────────────────────────────────────────────────────────
function gitAt(repoRoot, args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function main() {
  let repoRoot;
  try {
    repoRoot = gitAt(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  } catch {
    console.error('gate-pre-commit: 不在 git 仓库内');
    process.exit(2);
  }

  const diff = gitAt(repoRoot, ['diff', '--cached', '--no-color', '-U0']);
  if (!diff.trim()) {
    console.log('gate-pre-commit: 暂存区为空，跳过。');
    process.exit(0);
  }

  let compiled = [];
  const ignoreFile = path.join(repoRoot, '.gatesecretsignore');
  if (fs.existsSync(ignoreFile)) {
    compiled = compileIgnorePatterns(
      fs.readFileSync(ignoreFile, 'utf8').split('\n'),
    );
  }

  const violations = scanAddedLines(diff, compiled);
  if (violations.length > 0) {
    console.error(
      `✘ pre-commit 拦截：暂存新增行检出 ${violations.length} 处疑似密钥：`,
    );
    for (const violation of violations) {
      const description = PATTERN_DESCRIPTIONS[violation.patternId] ?? '';
      console.error(
        `    [${violation.patternId}] ${violation.path}:${violation.lineNo}（${description}）`,
      );
    }
    console.error(
      '真实密钥：撤销轮换后改用环境变量/加密存储，绝不提交。\n' +
        '假 key fixture：确认值完全虚构后，把文件路径加入 .gatesecretsignore。',
    );
    process.exit(1);
  }

  const stagedCount = gitAt(repoRoot, ['diff', '--cached', '--name-only'])
    .split('\n')
    .filter(Boolean).length;
  console.log(`✓ secret 扫描通过（${stagedCount} 个暂存文件）`);

  if (path.resolve(repoRoot) !== scriptRepoRoot) {
    console.log('· 格式检查跳过：hooks 被非本仓库调用（脚本与仓库不匹配）');
    process.exit(0);
  }
  const format = spawnSync(
    process.execPath,
    [path.join(scriptRepoRoot, 'scripts', 'check-format-changed.mjs')],
    { stdio: 'inherit' },
  );
  if (format.error || (format.status ?? 1) !== 0) {
    console.error(
      '✘ 格式检查未过：运行 npm run format:changed 后重新暂存提交。',
    );
    process.exit(format.status ?? 1);
  }
  console.log('✓ 格式检查通过');
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
