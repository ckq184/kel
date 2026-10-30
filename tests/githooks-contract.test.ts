import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import {
  COMMIT_MSG_EXEMPT_PATTERNS,
  COMMIT_TYPES,
  validateCommitMessage,
} from '../scripts/gate-commit-msg.mjs';
import {
  compileIgnorePatterns,
  isIgnored,
  scanAddedLines,
  scanText,
} from '../scripts/gate-pre-commit.mjs';
import { removeTmpDirRecursive } from './helpers/remove-tmp-dir';

const repoRoot = process.cwd();
const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) removeTmpDirRecursive(dir);
});

function makeTmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'githooks-contract-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

describe('commit-msg 门禁（宪法第 8 条 + house style）', () => {
  test('白名单 type + 「 - 」分隔的 house style 通过', () => {
    expect(validateCommitMessage('feat: 工作区 - 新增导出入口')).toEqual({
      ok: true,
    });
    expect(
      validateCommitMessage('build: 门禁机审化 - 任务L批次2：引入 git hooks'),
    ).toEqual({ ok: true });
    expect(validateCommitMessage('revert: 任务K - 回滚基线修复')).toEqual({
      ok: true,
    });
  });

  test('完整白名单与宪法第 8 条一致', () => {
    expect(COMMIT_TYPES).toEqual([
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
    ]);
  });

  test('非白名单 type、大写 type、缺冒号空格均拒绝', () => {
    expect(validateCommitMessage('foo: 范围 - 摘要').ok).toBe(false);
    expect(validateCommitMessage('FEAT: 范围 - 摘要').ok).toBe(false);
    expect(validateCommitMessage('feat:范围 - 摘要').ok).toBe(false);
  });

  test('缺「 - 」分隔、缺范围或缺摘要均拒绝', () => {
    expect(validateCommitMessage('feat: 工作区新增导出入口').ok).toBe(false);
    expect(validateCommitMessage('feat: - 摘要').ok).toBe(false);
    expect(validateCommitMessage('feat: 范围 -').ok).toBe(false);
    expect(validateCommitMessage('feat: 范围 - ').ok).toBe(false);
  });

  test('git 自动生成与 rebase 辅助消息豁免', () => {
    expect(COMMIT_MSG_EXEMPT_PATTERNS.length).toBeGreaterThan(0);
    expect(validateCommitMessage("Merge branch 'feature-x'").ok).toBe(true);
    expect(
      validateCommitMessage(
        'Revert "feat: 工作区 - 新增导出入口"\n\nThis reverts commit abc.',
      ).ok,
    ).toBe(true);
    expect(validateCommitMessage('fixup! feat: 工作区 - 导出').ok).toBe(true);
  });

  test('多行消息只校验首行，正文自由', () => {
    const ok = validateCommitMessage(
      'docs: 交接 - 收官记录\n\n执行记录：\n- 批次 1 已落地\n- password: string 这类正文不校验',
    );
    expect(ok.ok).toBe(true);
  });

  test('空首行拒绝', () => {
    expect(validateCommitMessage('\n\n正文').ok).toBe(false);
  });

  test('CLI：坏首行退出码 1 且错误信息给出正确示例', () => {
    const bad = path.join(os.tmpdir(), `githooks-msg-bad-${process.pid}.txt`);
    fs.writeFileSync(bad, '随便写的一句话\n');
    const badRun = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts', 'gate-commit-msg.mjs'),
      bad,
    ]);
    expect(badRun.status).toBe(1);
    expect(`${badRun.stdout}${badRun.stderr}`).toContain('正确示例');
    fs.rmSync(bad, { force: true });

    const good = path.join(os.tmpdir(), `githooks-msg-good-${process.pid}.txt`);
    fs.writeFileSync(good, 'feat: 工作区 - 新增导出入口\n');
    const goodRun = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts', 'gate-commit-msg.mjs'),
      good,
    ]);
    expect(goodRun.status).toBe(0);
    fs.rmSync(good, { force: true });
  });
});

describe('pre-commit secret 扫描（真相源 = src/ 与 agent-runner 的 redact 实现）', () => {
  test('厂商前缀 token 命中（sk-/ghp_/github_pat_/glpat-/xoxb-/AKIA/AIza/sk_live_/SG./npm_）', () => {
    const hits = [
      'const key = "sk-ant-abcdefghijklmnopqrst";',
      'token: sk-1234567890abcdefghij',
      'ghp_1234567890abcdefghij1234567890',
      'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz',
      'glpat-1234567890abcdefghij',
      'xoxb-1234567890-abcde-fghij',
      'AKIAIOSFODNN7EXAMPLE',
      'ASIAIOSFODNN7EXAMPLE',
      'AIzaSyA1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tU12',
      'sk_live_1234567890abcdef',
      'SG.1234567890abcdefg.1234567890abcdefg',
      'npm_1234567890abcdefghijklmnopqrstuv',
      '-----BEGIN RSA PRIVATE KEY-----',
    ];
    for (const line of hits) {
      expect(scanText(line), `应命中：${line.slice(0, 24)}…`).not.toHaveLength(
        0,
      );
    }
  });

  test('\\b 边界防误报：文档路径 task-k-… 与普通单词不命中', () => {
    expect(
      scanText('见 docs/task-k-windows-test-baseline-triage-plan.md §8'),
    ).toHaveLength(0);
    expect(scanText('使用 mask-token-pattern 之类的描述文字')).toHaveLength(0);
  });

  test('Bearer/Basic、JWT、DSN userinfo、键值对赋值命中', () => {
    expect(scanText('Authorization: Bearer abcdefghijklmnop')).not.toHaveLength(
      0,
    );
    expect(
      scanText('Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA=='),
    ).not.toHaveLength(0);
    expect(
      scanText(
        'const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N65IWDcJMzT"',
      ),
    ).not.toHaveLength(0);
    expect(
      scanText('postgres://admin:secretpw@db.local:5432/app'),
    ).not.toHaveLength(0);
    expect(scanText('"app_secret": "cli_a1b2c3d4e5f6g7h8"')).not.toHaveLength(
      0,
    );
    expect(scanText('apiKey = "abcdefghij1234567890"')).not.toHaveLength(0);
  });

  test('代码形态误报防线：类型注解、env 引用与占位符不命中', () => {
    expect(scanText('interface Login { password: string }')).toHaveLength(0);
    expect(scanText('const cookie: Record<string, string> = {}')).toHaveLength(
      0,
    );
    expect(scanText('apiKey: process.env.API_KEY2')).toHaveLength(0);
    expect(scanText('apiKey: "***"')).toHaveLength(0);
    expect(scanText('apiKey: "<your-api-key>"')).toHaveLength(0);
  });

  test('误报防线回归：全库扫描踩过的真实代码形态（批次 2 定型）', () => {
    // im-manager.ts 模板字面量
    expect(
      scanText('const credentialKey = `${provider}\\0${fingerprint}`'),
    ).toHaveLength(0);
    // reset-admin.ts 的 process.argv
    expect(scanText('const nextPassword = process.argv[3];')).toHaveLength(0);
    // routes/config.ts 的 URL 常量（内嵌凭据 URL 由 url-userinfo 单独覆盖）
    expect(
      scanText(
        "const OAUTH_TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token'",
      ),
    ).toHaveLength(0);
    // runtime-config.ts 的点路径属性
    expect(
      scanText('anthropicApiKey: v3.officialSecrets.anthropicApiKey,'),
    ).toHaveLength(0);
    // workspace-memory-capability.ts 的正则字面量
    expect(
      scanText('const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;'),
    ).toHaveLength(0);
    // 注释散文与 UI 占位（auth-scheme ≥12 收敛）
    expect(scanText(' * the reusable bearer material.')).toHaveLength(0);
    expect(scanText('placeholder="Bearer token..."')).toHaveLength(0);
    // cookie 名常量（无数字混排）
    expect(
      scanText('const SESSION_COOKIE_NAME_PLAIN = "ckqclaw_session"'),
    ).toHaveLength(0);
  });

  test('scanAddedLines：只扫新增行、行号取新侧、跳过 /dev/null 与未变更', () => {
    const diff = [
      'diff --git a/config.ts b/config.ts',
      'index 111..222 100644',
      '--- a/config.ts',
      '+++ b/config.ts',
      '@@ -1,2 +1,3 @@',
      ' context line',
      '-removed sk-1234567890abcdefghij',
      '+const key = "sk-1234567890abcdefghij";',
      '+const kind: string = "text";',
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-ghp_1234567890abcdefghij1234567890',
    ].join('\n');
    const violations = scanAddedLines(diff, []);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      path: 'config.ts',
      lineNo: 2,
      patternId: 'vendor-prefix-sk',
    });
  });

  test('scanAddedLines 命中行不回显内容（只带位置与模式 id）', () => {
    const diff = [
      '+++ b/k.ts',
      '@@ -0,0 +1 @@',
      '+sk-1234567890abcdefghij',
    ].join('\n');
    const [violation] = scanAddedLines(diff, []);
    expect(Object.keys(violation).sort()).toEqual([
      'lineNo',
      'path',
      'patternId',
    ]);
  });

  test('.gatesecretsignore 匹配：精确路径、单段 *、跨段 **、注释与空行', () => {
    const compiled = compileIgnorePatterns([
      '# 注释行',
      '',
      'tests/agent-runner-utils-redact.test.ts',
      'docs/*.md',
      'fixtures/**',
    ]);
    expect(isIgnored('tests/agent-runner-utils-redact.test.ts', compiled)).toBe(
      true,
    );
    expect(isIgnored('docs/README.md', compiled)).toBe(true);
    expect(isIgnored('docs/sub/nested.md', compiled)).toBe(false);
    expect(isIgnored('fixtures/a/b/c.txt', compiled)).toBe(true);
    expect(isIgnored('src/config.ts', compiled)).toBe(false);
    expect(isIgnored('tests/other.test.ts', compiled)).toBe(false);
  });

  test('CLI 集成：temp 仓库暂存假密钥被拦截（先于格式检查，退出码 1）', () => {
    const repo = makeTmpRepo();
    fs.writeFileSync(
      path.join(repo, 'leak.ts'),
      'const k = "sk-1234567890abcdefghij";\n',
    );
    execFileSync('git', ['add', 'leak.ts'], { cwd: repo, stdio: 'ignore' });
    const run = spawnSync(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'gate-pre-commit.mjs')],
      { cwd: repo, encoding: 'utf8' },
    );
    expect(run.status).toBe(1);
    expect(`${run.stdout}${run.stderr}`).toContain('leak.ts');
  });
});

// 全量负载下 Windows 子进程 spawn 显著变慢（git init + 两次安装器 + 多个
// git 调用；任务 L 批次 2 收官轮实测默认 5s 被超，单跑 2.9s 绿——任务 K §8
// 同构的边缘预算现象），显式放宽到 30s。
describe('hooks 安装器', () => {
  test('一次生效：写 core.hooksPath 并把 .githooks 归一为 LF（幂等）', () => {
    const repo = makeTmpRepo();
    fs.mkdirSync(path.join(repo, '.githooks'));
    fs.writeFileSync(
      path.join(repo, '.githooks', 'pre-commit'),
      '#!/bin/sh\r\nexec node "$(git rev-parse --show-toplevel)/scripts/gate-pre-commit.mjs" "$@"\r\n',
    );
    const run = spawnSync(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'install-githooks.mjs')],
      { cwd: repo, encoding: 'utf8' },
    );
    expect(run.status).toBe(0);
    const hooksPath = execFileSync('git', ['config', 'core.hooksPath'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    expect(hooksPath).toBe('.githooks');
    const hook = fs.readFileSync(
      path.join(repo, '.githooks', 'pre-commit'),
      'utf8',
    );
    expect(hook).not.toContain('\r');

    const run2 = spawnSync(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'install-githooks.mjs')],
      { cwd: repo, encoding: 'utf8' },
    );
    expect(run2.status).toBe(0);
  }, 30_000);

  test('本仓库自带 .githooks 三个 shim 且为 LF', () => {
    for (const name of ['pre-commit', 'commit-msg', 'pre-push']) {
      const file = path.join(repoRoot, '.githooks', name);
      expect(fs.existsSync(file), `${name} 应存在`).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).not.toContain('\r');
    }
  });

  test('.gitattributes 锁定可执行文本检出为 LF（任务 N 轻量裁决）', () => {
    const attributes = fs.readFileSync(
      path.join(repoRoot, '.gitattributes'),
      'utf8',
    );
    // CRLF 会破坏 sh shebang/命令行；删规则会让 autocrlf 环境的检出
    // 重新踩任务 L 批次 2 的坑（安装器归一只剩兜底）。
    expect(attributes).toMatch(/^\.githooks\/\*\s+eol=lf$/m);
    expect(attributes).toMatch(/^\*\.sh\s+eol=lf$/m);
  });
});
