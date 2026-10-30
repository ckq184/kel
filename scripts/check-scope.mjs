#!/usr/bin/env node
// CKQClaw 范围核对（任务 L 批次 3 原型，宪法 1.5「最小范围修改」的机审化）。
//
// 把「git diff 文件清单 vs 任务声明范围」变成一条命令：
//   node scripts/check-scope.mjs
//
// 声明格式 = 仓库根 `.gatescope.json`：
//   {
//     "task": "任务X - 一句话",      // 任务名（输出用）
//     "base": "<commit>",           // 开工前 HEAD（回滚点），diff 基线
//     "allow": ["scripts/**", ...]  // 允许触碰的路径 glob
//   }
//   glob 语义与 .gatesecretsignore 相同：* 单段、** 跨段（实现复用
//   gate-pre-commit.mjs 的匹配器，单一实现）。
//
// 检查内容：base→当前工作树（含已改/已暂存/未跟踪）的每个路径都必须命中
// allow；`.gatescope.json` 自身自动允许——扩宽范围只能通过改声明文件，
// 而声明文件进 diff，扩宽行为对审查者可见（审计轨迹语义）。
//
// 说服力边界（如实声明，宪法 1.5 行过渡注同源）：这是审计轨迹型防线而非
// 硬边界——实现者仍可扩宽声明，但扩宽必须是显式 diff，由立项声明的批准
// 者（用户）复核。约定：声明随任务立项提交落档（此时 base=立项 HEAD 的
// 父提交或立项提交本身），实现批次不得顺手扩宽；确需扩宽时在提交信息与
// 声明变更 diff 中说明理由。
//
// 退出码：0=全在范围内；1=存在范围外路径；2=声明缺失/非法/base 不可解析。
// 定位：与 verify 并列的手动门禁（不并入六步，verify 步骤集锁定 CLAUDE.md
// §10）；建议在提交前与 npm run verify 一同执行。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileIgnorePatterns, isIgnored } from './gate-pre-commit.mjs';

export const DECLARATION_FILE = '.gatescope.json';

// ─── 声明解析 ────────────────────────────────────────────────────────────
export function validateDeclaration(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${DECLARATION_FILE} 不是合法 JSON`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${DECLARATION_FILE} 顶层须为对象`);
  }
  if (typeof parsed.task !== 'string' || !parsed.task.trim()) {
    throw new Error(`${DECLARATION_FILE} 缺少非空字符串字段 task`);
  }
  if (typeof parsed.base !== 'string' || !parsed.base.trim()) {
    throw new Error(`${DECLARATION_FILE} 缺少非空字符串字段 base`);
  }
  if (
    !Array.isArray(parsed.allow) ||
    parsed.allow.length === 0 ||
    !parsed.allow.every((item) => typeof item === 'string' && item.trim())
  ) {
    throw new Error(`${DECLARATION_FILE} 的 allow 须为非空字符串数组`);
  }
  return { task: parsed.task, base: parsed.base, allow: parsed.allow };
}

// ─── 变更路径采集（base→工作树全量）──────────────────────────────────────
export function collectChangedPaths(repoRoot, base) {
  const git = (args) =>
    execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  const paths = new Set();
  // --no-renames：增/删两侧路径都列出，删除同受范围约束
  for (const line of git(['diff', '--name-only', '--no-renames', base]).split(
    '\n',
  )) {
    if (line.trim()) paths.add(line.trim());
  }
  for (const line of git(['ls-files', '--others', '--exclude-standard']).split(
    '\n',
  )) {
    if (line.trim()) paths.add(line.trim());
  }
  return [...paths];
}

// ─── 归类与审计 ──────────────────────────────────────────────────────────
// changedPaths 中声明文件自身自动允许；changedPaths 同时用于判定声明是否
// 在 base 后被改过（首个声明或扩宽均触发审计提示）。
export function auditScope(changedPaths, allowPatterns) {
  const compiled = compileIgnorePatterns(allowPatterns);
  const inScope = [];
  const outOfScope = [];
  let declarationChanged = false;
  for (const target of changedPaths) {
    if (target === DECLARATION_FILE) {
      declarationChanged = true;
      inScope.push({ path: target, via: '(声明文件，自动允许)' });
      continue;
    }
    if (isIgnored(target, compiled)) {
      inScope.push({ path: target, via: 'allow' });
    } else {
      outOfScope.push({ path: target });
    }
  }
  return { inScope, outOfScope, declarationChanged };
}

// ─── CLI ─────────────────────────────────────────────────────────────────
function main() {
  let repoRoot;
  try {
    repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    console.error('check-scope: 不在 git 仓库内');
    process.exit(2);
  }

  const declarationPath = path.join(repoRoot, DECLARATION_FILE);
  if (!fs.existsSync(declarationPath)) {
    console.error(
      `check-scope: 缺少 ${DECLARATION_FILE}。任务立项提交时创建：\n` +
        JSON.stringify(
          {
            task: '任务X - 一句话',
            base: '<开工前 HEAD>',
            allow: ['<允许路径 glob>'],
          },
          null,
          2,
        ),
    );
    process.exit(2);
  }

  let declaration;
  try {
    declaration = validateDeclaration(fs.readFileSync(declarationPath, 'utf8'));
  } catch (error) {
    console.error(`check-scope: ${error.message}`);
    process.exit(2);
  }

  let baseOk = true;
  try {
    execFileSync(
      'git',
      ['rev-parse', '--verify', `${declaration.base}^{commit}`],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    baseOk = false;
  }
  if (!baseOk) {
    console.error(
      `check-scope: 声明的 base "${declaration.base}" 不是可解析的提交` +
        `（应 pin 任务开工前 HEAD）`,
    );
    process.exit(2);
  }

  const changedPaths = collectChangedPaths(repoRoot, declaration.base);
  if (changedPaths.length === 0) {
    console.log(`✓ ${declaration.task}：base 之后无任何变更路径。`);
    process.exit(0);
  }

  const audit = auditScope(changedPaths, declaration.allow);

  console.log(`任务：${declaration.task}`);
  console.log(
    `基线：${declaration.base} → 工作树，共 ${changedPaths.length} 个路径：`,
  );
  for (const item of audit.inScope) {
    console.log(`    ✓ ${item.path}（${item.via}）`);
  }

  if (audit.declarationChanged) {
    console.log(
      '⚠️  范围声明自 base 后新增/变更——首个声明（正常）或范围扩宽（须在提交信息说明理由，由立项批准者复核）。',
    );
  }

  if (audit.outOfScope.length > 0) {
    console.error(`\n✘ ${audit.outOfScope.length} 个路径在声明范围外：`);
    for (const item of audit.outOfScope) {
      console.error(`    ✘ ${item.path}`);
    }
    console.error(
      '\n处置：回滚范围外改动；或确属任务必需时，把路径 glob 加入 ' +
        `${DECLARATION_FILE} 的 allow 并在提交信息说明理由（声明变更会进 diff，供审查）。\n` +
        '当前 allow：',
    );
    for (const pattern of declaration.allow) {
      console.error(`    - ${pattern}`);
    }
    process.exit(1);
  }

  console.log(`✓ 范围核对通过：${audit.inScope.length} 个路径全在声明范围内。`);
  process.exit(0);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
