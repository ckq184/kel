#!/usr/bin/env node
// CKQClaw 提交前门槛一键机审（任务 L 批次 1）。
//
// 把 CLAUDE.md §10「提交前门槛」六步封装为顺序执行、失败即停的一条命令：
//   npm run verify
// 步骤与顺序的唯一真相源是 CLAUDE.md §10 的 bash 代码块；本脚本的
// VERIFY_STEPS 是它的代码化投影，两者由 tests/verify-gate-contract.test.ts
// 逐字（含顺序）锁定：§10 变更而 VERIFY_STEPS 未跟上即测试红——宪法第 9 条。
//
// Windows 原生兼容（开发机无 make；等价链任务 K 两批实测）：
//   - npm/npx 子命令经 shell:true 执行：node 在 Windows 下 ENOENT/EINVAL
//     拒绝无 shell 的 npm 直启（CVE-2024-27980 后的行为）；
//   - scripts/*.sh 经 Git Bash 运行：win32 下 resolveBash() 解析 MSYS bash
//     （PATH 无 MSYS 目录时从 git.exe 安装目录推导；排除 System32 的 WSL
//     bash）。bash.exe 的 MSYS 运行时会自举 /usr/bin，故脚本内 find/awk/sed
//     等与来源 shell 无关（任务 L 批次 1 探针实测）；
//   - make build 的 `touch .build-sentinel` 用 fs open('a') 等价实现；
//   - `git diff --check` 只按退出码判败：core.autocrlf=true 下其余文件的
//     autocrlf warning 是噪音（任务 K 实测；可执行文本已由 .gitattributes
//     eol=lf 锁定，任务 N 轻量裁决）。
//
// 用法：
//   node scripts/verify.mjs            # 六步全跑（提交前门槛本体）
//   node scripts/verify.mjs --step 3   # 只跑第 3 步（排障用，不构成完整门禁）
//   node scripts/verify.mjs --list     # 列出步骤清单
//
// 测试专用接缝：环境变量 VERIFY_STEPS_JSON（JSON 步骤数组）替换内置步骤，
// 供 tests/verify-gate-contract.test.ts 注入成功/失败假步骤；设置时打印
// 醒目警告，禁止用于真实门禁。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const USAGE = `用法：
  node scripts/verify.mjs            六步全跑（提交前门槛）
  node scripts/verify.mjs --step <n> 只跑第 n 步（排障，1 起）
  node scripts/verify.mjs --list     列出步骤`;

// ─── 步骤清单（单一来源；契约测试锁与 CLAUDE.md §10 同步）───────────────
//
// 每步：{ name, docCommand, commands, note?, failHint? }
//   docCommand 必须与 CLAUDE.md §10 代码块逐行一致（含顺序）；
//   commands 每项恰居其一：
//     { run: '<shell 命令串>' }      经 shell 执行（npm/npx/常驻工具）
//     { sh: '<repo 相对 .sh 路径>' } 经 resolveBash() 的 bash 执行
//     { touchFile: '<repo 相对路径>' } 等价 touch（存在则仅刷新 mtime）
//     可选 cwd: '<repo 相对目录>'。
export const VERIFY_STEPS = [
  {
    name: 'format:changed',
    docCommand: 'npm run format:changed',
    commands: [{ run: 'npm run format:changed' }],
  },
  {
    name: 'docs:check',
    docCommand: 'npm run docs:check',
    commands: [{ run: 'npm run docs:check' }],
  },
  {
    name: 'typecheck',
    docCommand: 'make typecheck',
    note: 'make typecheck 的无 make 等价链（任务 K 实测）；docs:check 已在步骤 2 执行，不重复',
    commands: [
      { sh: 'scripts/sync-stream-event.sh' },
      { run: 'npx tsc --noEmit' },
      { run: 'npx tsc --noEmit', cwd: 'web' },
      { run: 'npx tsc --noEmit', cwd: 'container/agent-runner' },
      { sh: 'scripts/check-stream-event-sync.sh' },
      { sh: 'scripts/check-agent-runner-prompts.sh' },
    ],
  },
  {
    name: 'test',
    docCommand: 'make test',
    failHint:
      '连续重跑出现新失败时先冷却复测再定性：满载下边缘预算/时序用例会轮换翻红，单跑均绿（docs/task-k-windows-test-baseline-triage-plan.md §8）',
    commands: [{ run: 'npx vitest run' }],
  },
  {
    name: 'build',
    docCommand: 'make build',
    note: 'make build = sync-types + build:all + touch .build-sentinel；sync 已在步骤 3 执行',
    commands: [{ run: 'npm run build:all' }, { touchFile: '.build-sentinel' }],
  },
  {
    name: 'git diff --check',
    docCommand: 'git diff --check',
    note: '只按退出码判败：autocrlf warning 是噪音（core.autocrlf=true，其余文件无行尾属性；可执行文本已 eol=lf，任务 N）',
    commands: [{ run: 'git diff --check' }],
  },
];

// ─── Git Bash 解析（win32；POSIX 恒为 'bash'）────────────────────────────
let bashPathCache;

function resolveBash() {
  if (process.platform !== 'win32') return 'bash';
  if (bashPathCache) return bashPathCache;
  const candidates = [];
  if (process.env.CKQCLAW_BASH) candidates.push(process.env.CKQCLAW_BASH);
  candidates.push('bash'); // Git Bash 会话内 PATH 直接可解析
  // cmd/PowerShell 来源的 PATH 无 MSYS 目录：从 git.exe 安装位置向上推导。
  // where.exe 可能先命中 cmd\git.exe 或 mingw64\bin\git.exe，两者向上爬
  // 都会到 Git 安装根（bin\bash.exe 为标准布局）。
  try {
    const gitLines = execFileSync('where.exe', ['git.exe'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    for (const gitPath of gitLines) {
      let dir = path.dirname(gitPath.trim());
      for (let depth = 0; depth < 4 && dir; depth += 1) {
        candidates.push(path.join(dir, 'bin', 'bash.exe'));
        candidates.push(path.join(dir, 'usr', 'bin', 'bash.exe'));
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  } catch {
    // where.exe 不可用则跳过推导
  }
  for (const candidate of candidates) {
    try {
      const uname = execFileSync(candidate, ['-c', 'uname -s'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      // MINGW/MSYS/CYGWIN = Git Bash；System32 的 WSL bash 报 Linux，须排除
      if (/^(?:MINGW|MSYS|CYGWIN)/.test(uname)) {
        bashPathCache = candidate;
        return candidate;
      }
    } catch {
      // 候选不可执行，继续下一个
    }
  }
  console.error(
    'verify: 未找到 Git Bash（运行 scripts/*.sh 需要 MINGW/MSYS bash）。' +
      '可安装 Git for Windows，或设 CKQCLAW_BASH 指向 bash.exe。',
  );
  process.exit(2);
}

// ─── 命令执行 ────────────────────────────────────────────────────────────
function commandDisplay(entry) {
  if (entry.touchFile) return `touch ${entry.touchFile}`;
  if (entry.sh) return `bash ${entry.sh}`;
  return entry.run;
}

function runCommand(entry) {
  if (entry.touchFile) {
    const fd = fs.openSync(path.join(repoRoot, entry.touchFile), 'a');
    fs.closeSync(fd);
    return { code: 0 };
  }
  let command;
  let env = process.env;
  if (entry.sh) {
    const isAbsolute =
      /^[A-Za-z]:[\\/]/.test(entry.sh) || entry.sh.startsWith('/');
    command = isAbsolute
      ? `"${resolveBash()}" "${entry.sh}"`
      : `"${resolveBash()}" ${entry.sh}`;
    // MSYS 关键坑（任务 L 批次 1 实测）：node 由 Git Bash 派生时继承的 PWD
    // 是 Windows 形态（D:/...），子 bash 的 pwd 随之输出 Windows 路径，`D:`
    // 的冒号会打散 check-agent-runner-prompts.sh 中 sed 的
    // `file:line:content` 切分（grep -H 前缀多了盘符冒号）→ 0 命中 → 防呆
    // 守卫误报。剥离 PWD/OLDPWD 让 bash 按 getcwd 自建 MSYS 形态 PWD，与从
    // Git Bash 终端直接运行这些脚本的既有行为一致；POSIX 下 shell 自行重建
    // PWD，同样无害。
    env = { ...process.env };
    delete env.PWD;
    delete env.OLDPWD;
  } else {
    command = entry.run;
  }
  const result = spawnSync(command, {
    shell: true,
    cwd: entry.cwd ? path.join(repoRoot, entry.cwd) : repoRoot,
    stdio: 'inherit',
    env,
  });
  if (result.error) {
    console.error(`verify: 无法启动子命令：${result.error.message}`);
    return { code: 1 };
  }
  return { code: result.status ?? 1, signal: result.signal };
}

function formatDuration(ms) {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds - minutes * 60)}s`;
}

// ─── 门禁主流程 ──────────────────────────────────────────────────────────
// 返回 { ok, exitCode }；失败时 exitCode = 失败子命令的退出码（无则 1）。
export function runGate(steps, only = null) {
  const total = steps.length;
  const gateStart = Date.now();
  const passed = [];
  let stoppedAt = null;
  let exitCode = 0;

  for (let index = 1; index <= total; index += 1) {
    const step = steps[index - 1];
    if (only !== null && only !== index) {
      continue;
    }
    console.log(`\n[${index}/${total}] ${step.docCommand || step.name}`);
    if (step.note) console.log(`    · ${step.note}`);
    const stepStart = Date.now();
    for (const entry of step.commands) {
      const display = commandDisplay(entry);
      console.log(
        entry.cwd ? `    $ (${entry.cwd}) ${display}` : `    $ ${display}`,
      );
      const outcome = runCommand(entry);
      if (outcome.code !== 0) {
        const detail = outcome.signal
          ? `被信号 ${outcome.signal} 终止`
          : `exit ${outcome.code}`;
        console.error(
          `\n✘ ${index}/${total} ${step.name} 失败：子命令 \`${display}\` ${detail}` +
            `（${formatDuration(Date.now() - stepStart)}）`,
        );
        if (step.failHint) console.error(`    提示：${step.failHint}`);
        stoppedAt = { step, index, display };
        exitCode = outcome.code;
        break;
      }
    }
    if (stoppedAt) break;
    console.log(
      `✔ ${index}/${total} ${step.name} 通过（${formatDuration(Date.now() - stepStart)}）`,
    );
    passed.push(step);
  }

  console.log('');
  if (stoppedAt) {
    console.error(
      `❌ verify 失败于步骤 ${stoppedAt.index}/${total}（${stoppedAt.step.name}）` +
        `，已过 ${passed.length} 步，总耗时 ${formatDuration(Date.now() - gateStart)}：`,
    );
    for (let index = 1; index <= total; index += 1) {
      const step = steps[index - 1];
      if (index < stoppedAt.index) {
        console.error(`    ✔ ${index} ${step.name}`);
      } else if (index === stoppedAt.index) {
        console.error(
          `    ✘ ${index} ${step.name}（\`${stoppedAt.display}\`）`,
        );
      } else {
        console.error(`    · ${index} ${step.name}（未执行）`);
      }
    }
    return { ok: false, exitCode: exitCode || 1 };
  }

  if (only !== null) {
    console.log(
      `✅ 步骤 ${only}/${total}（${steps[only - 1].name}）通过（单步排障，不构成完整门禁）`,
    );
  } else {
    console.log(
      `✅ verify 全绿：${total}/${total} 步通过，总耗时 ${formatDuration(Date.now() - gateStart)}`,
    );
  }
  return { ok: true, exitCode: 0 };
}

// ─── VERIFY_STEPS_JSON 覆盖（测试接缝）──────────────────────────────────
function parseStepsOverride(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(`verify: VERIFY_STEPS_JSON 不是合法 JSON：${error.message}`);
    process.exit(2);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    console.error('verify: VERIFY_STEPS_JSON 须为非空步骤数组');
    process.exit(2);
  }
  for (const step of parsed) {
    if (!step || typeof step.name !== 'string' || !step.name) {
      console.error('verify: VERIFY_STEPS_JSON 每步须有非空 name');
      process.exit(2);
    }
    if (!Array.isArray(step.commands) || step.commands.length === 0) {
      console.error(`verify: 步骤 ${step.name} 须有非空 commands`);
      process.exit(2);
    }
    for (const entry of step.commands) {
      const kinds = ['run', 'sh', 'touchFile'].filter(
        (kind) => entry[kind] !== undefined,
      );
      if (kinds.length !== 1) {
        console.error(
          `verify: 步骤 ${step.name} 的命令须恰含 run/sh/touchFile 之一`,
        );
        process.exit(2);
      }
    }
  }
  console.error(
    '⚠️  VERIFY_STEPS_JSON 已设置：内置六步被替换为注入步骤（测试专用，不构成真实门禁）。',
  );
  return parsed;
}

// ─── CLI ─────────────────────────────────────────────────────────────────
function main(argv) {
  let only = null;
  let listOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list') {
      listOnly = true;
    } else if (arg === '--step') {
      const value = argv[i + 1];
      const parsed = Number(value);
      if (!/^\d+$/.test(value ?? '') || parsed < 1) {
        console.error(
          `verify: --step 须为 1 起的步骤序号，收到 ${value ?? '(缺参)'}`,
        );
        console.error(USAGE);
        process.exit(2);
      }
      only = parsed;
      i += 1;
    } else {
      console.error(`verify: 未知参数 ${arg}`);
      console.error(USAGE);
      process.exit(2);
    }
  }

  let steps = VERIFY_STEPS;
  if (process.env.VERIFY_STEPS_JSON) {
    steps = parseStepsOverride(process.env.VERIFY_STEPS_JSON);
  }

  if (listOnly) {
    steps.forEach((step, index) => {
      console.log(
        `${index + 1}. ${step.docCommand || step.name}（${step.name}）`,
      );
    });
    return;
  }

  if (only !== null) {
    if (only > steps.length) {
      console.error(`verify: --step ${only} 超出范围（共 ${steps.length} 步）`);
      console.error(USAGE);
      process.exit(2);
    }
    console.log(
      `单步排障模式：仅运行步骤 ${only}/${steps.length}（不构成完整门禁，提交前仍须完整 verify）`,
    );
  } else if (steps === VERIFY_STEPS) {
    console.log(
      'CKQClaw verify —— 提交前门槛（六步，失败即停）。\n' +
        '步骤真相源：CLAUDE.md §10；与 VERIFY_STEPS 的同步由 tests/verify-gate-contract.test.ts 锁定。',
    );
  }

  const result = runGate(steps, only);
  process.exitCode = result.exitCode;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2));
}
