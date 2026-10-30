import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { VERIFY_STEPS } from '../scripts/verify.mjs';

const repoRoot = process.cwd();
const verifyScript = path.join(repoRoot, 'scripts', 'verify.mjs');

/**
 * CLAUDE.md §10「提交前门槛」的 bash 代码块是六步门槛的唯一真相源；
 * scripts/verify.mjs 的 VERIFY_STEPS 是它的代码化投影。本契约测试把两者
 * 逐字（含顺序）锁在一起：§10 变更而 VERIFY_STEPS 未跟上（或反之）即红。
 */
function gateCommandsFromClaudeMd(): string[] {
  const text = fs.readFileSync(path.join(repoRoot, 'CLAUDE.md'), 'utf8');
  const headingIndex = text.indexOf('### 提交前门槛');
  expect(
    headingIndex,
    'CLAUDE.md 应包含「### 提交前门槛」小节',
  ).toBeGreaterThanOrEqual(0);
  const fence = text.slice(headingIndex).match(/```bash\r?\n([\s\S]*?)```/);
  expect(fence, '「### 提交前门槛」小节应含一个 bash 代码块').not.toBeNull();
  return fence![1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function runVerify(
  args: string[],
  envOverride: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [verifyScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...envOverride },
  });
}

function markerPath(tag: string): string {
  return path
    .join(os.tmpdir(), `verify-gate-test-${process.pid}-${tag}.flag`)
    .replace(/\\/g, '/');
}

function writeMarkerStep(name: string, file: string) {
  return {
    name,
    commands: [{ run: `node -e "require('fs').writeFileSync('${file}', '')"` }],
  };
}

const markerFiles = ['a', 'b', 'step2'].map(markerPath);
afterAll(() => {
  for (const file of markerFiles) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe('verify gate contract', () => {
  test('VERIFY_STEPS 与 CLAUDE.md §10 提交前门槛六步逐字一致（含顺序）', () => {
    expect(VERIFY_STEPS).toHaveLength(6);
    expect(VERIFY_STEPS.map((step) => step.docCommand)).toEqual(
      gateCommandsFromClaudeMd(),
    );
  });

  test('package.json 把 npm run verify 接到本脚本', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    );
    expect(pkg.scripts.verify).toBe('node scripts/verify.mjs');
  });

  test('每个步骤都携带可执行命令，且 run/sh/touchFile 形态恰居其一', () => {
    for (const step of VERIFY_STEPS) {
      expect(
        step.commands.length,
        `步骤 ${step.name} 应有命令`,
      ).toBeGreaterThan(0);
      for (const entry of step.commands) {
        const kinds = ['run', 'sh', 'touchFile'].filter(
          (kind) => entry[kind] !== undefined,
        );
        expect(kinds, JSON.stringify(entry)).toHaveLength(1);
      }
    }
  });
});

describe('verify gate runner behavior (injected steps)', () => {
  const okStep = {
    name: 'always-ok',
    commands: [{ run: 'node -e "process.exit(0)"' }],
  };
  const boomStep = {
    name: 'boom',
    commands: [{ run: 'node -e "process.exit(7)"' }],
  };

  test('全绿路径：全部步骤通过并输出汇总', () => {
    const result = runVerify([], {
      VERIFY_STEPS_JSON: JSON.stringify([
        writeMarkerStep('write-a', markerFiles[0]),
        okStep,
      ]),
    });
    expect(result.status).toBe(0);
    const out = `${result.stdout}${result.stderr}`;
    expect(out).toContain('verify 全绿');
    expect(fs.existsSync(markerFiles[0])).toBe(true);
  });

  test('失败即停（fail-fast）：失败步之后的命令不执行，并汇总未执行步骤', () => {
    const result = runVerify([], {
      VERIFY_STEPS_JSON: JSON.stringify([
        okStep,
        boomStep,
        writeMarkerStep('write-b', markerFiles[1]),
      ]),
    });
    expect(result.status).toBe(7);
    const out = `${result.stdout}${result.stderr}`;
    expect(out).toContain('VERIFY_STEPS_JSON');
    expect(out).toContain('boom');
    expect(out).toContain('未执行');
    expect(fs.existsSync(markerFiles[1])).toBe(false);
  });

  test('--step n 仅运行第 n 步（排障模式，不跑其余步骤）', () => {
    const steps = JSON.stringify([
      boomStep,
      writeMarkerStep('step2', markerFiles[2]),
    ]);
    const ok = runVerify(['--step', '2'], { VERIFY_STEPS_JSON: steps });
    expect(ok.status).toBe(0);
    expect(fs.existsSync(markerFiles[2])).toBe(true);

    const boom = runVerify(['--step', '1'], { VERIFY_STEPS_JSON: steps });
    expect(boom.status).toBe(7);
  });

  test('--step 越界/缺参与未知参数按用法错误退出（exit 2）', () => {
    const env = { VERIFY_STEPS_JSON: JSON.stringify([okStep]) };
    expect(runVerify(['--step', '0'], env).status).toBe(2);
    expect(runVerify(['--step', '99'], env).status).toBe(2);
    expect(runVerify(['--step'], env).status).toBe(2);
    expect(runVerify(['--bogus'], env).status).toBe(2);
  });

  test('VERIFY_STEPS_JSON 非法内容按用法错误退出', () => {
    const result = runVerify([], { VERIFY_STEPS_JSON: 'not-json' });
    expect(result.status).toBe(2);
  });

  test('sh 步骤的子 bash 不继承 Windows 形态 PWD（MSYS 盘符冒号坑防护）', () => {
    // 回归锁：node 由 Git Bash 派生时 PWD=D:/... 会让子 bash 的 pwd 输出
    // Windows 路径，`D:` 冒号打散 check-agent-runner-prompts.sh 的 sed
    // `file:line:` 切分（任务 L 批次 1 首轮 verify 实测踩中）。
    const pwdOut = markerPath('pwd-out');
    const probeSh = markerPath('pwd-probe').replace(/\.flag$/, '.sh');
    fs.writeFileSync(probeSh, `printf '%s' "$PWD" > '${pwdOut}'\n`);
    const result = runVerify([], {
      VERIFY_STEPS_JSON: JSON.stringify([
        { name: 'pwd-probe', commands: [{ sh: probeSh }] },
      ]),
    });
    expect(result.status).toBe(0);
    const recordedPwd = fs.readFileSync(pwdOut, 'utf8');
    expect(
      recordedPwd,
      `子 bash 的 PWD 不应含盘符冒号：${recordedPwd}`,
    ).not.toMatch(/^[A-Za-z]:[\\/]/);
    expect(recordedPwd.startsWith('/')).toBe(true);
    fs.rmSync(probeSh, { force: true });
    fs.rmSync(pwdOut, { force: true });
  });
});
