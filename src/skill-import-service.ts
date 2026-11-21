/**
 * 技能导入服务——从 ZIP 压缩包或 Git 仓库安装技能目录（安全敏感）。
 *
 * 威胁模型与纵深防御（每层独立成立，勿因"上游已校验"而删任一层）：
 * 1. 入口校验：ZIP 大小上限 / Git URL 仅 HTTPS 且禁内嵌凭据 /
 *    主机必须解析为公网地址（assertResolvesToPublicAddress，防 SSRF）；
 * 2. 归档条目校验：路径穿越（`..`）、绝对路径、`\0` 字节、符号链接条目
 *    全部拒绝（zip-slip 防御）；
 * 3. 解压后二次校验（assertSafeSkillTree）：文件数 / 总字节数 / 再查符号链接
 *    ——条目头声明的大小可能撒谎，以落盘实际状态为准；
 * 4. Git clone 加固：pinned HTTPS 代理 + 禁重定向 / 禁 file 协议 /
 *    禁子模块 + shallow 单分支；clone 期间由目录配额监视器
 *    （runCommandWithDirectoryQuota）轮询磁盘占用，超限即杀整个进程组；
 * 5. 事务式安装（installSkillDirectoriesTransactionally）：staging 目录暂存 →
 *    旧版本先备份 → rename 落位 → commit 回调（调用方在此落库）→
 *    任一步失败则删除新装目录并从备份回滚，不留半装状态。
 *
 * 消费方：`src/routes/skills.ts` 的导入 API。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import { validateSkillId } from './skill-utils.js';
import {
  assertResolvesToPublicAddress,
  validateSafeHttpsUrl,
} from './url-safety.js';
import { SKILL_ARCHIVE_MAX_FILE_BYTES } from './http-upload-policy.js';
import {
  buildPinnedGitEnvironment,
  startPinnedHttpsProxy,
} from './safe-git-proxy.js';

const execFileAsync = promisify(execFile);
/** 解压后总字节数上限（防解压炸弹；ZIP 与 Git 共用）。 */
const MAX_EXPANDED_BYTES = 25 * 1024 * 1024;
/** 归档条目数与目录扫描深度上限（防耗尽 inode / 深层遍历拖垮事件循环）。 */
const MAX_ENTRIES = 1_000;
const MAX_SCAN_DEPTH = 5;
const MAX_GIT_REPOSITORY_BYTES = 64 * 1024 * 1024;
/** 子进程合并输出的保留上限（防超长报错撑爆内存/日志）。 */
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

interface SkillImportResult {
  installed: string[];
  sourceUrl?: string;
  version?: string;
}

interface DirectoryQuotaCommandOptions {
  command: string;
  args: string[];
  watchDir: string;
  maxBytes: number;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  pollIntervalMs?: number;
  label?: string;
}

function directorySizeUntil(root: string, maxBytes: number): number {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        pending.push(path.join(current, entry));
      }
      continue;
    }
    if (stat.isFile()) {
      total += stat.size;
      if (total > maxBytes) return total;
    }
  }
  return total;
}

/**
 * 执行子进程并以轮询方式监视目标目录的磁盘占用：超配额 / 超时 / 监视器自身
 * 出错时杀掉整个进程组（detached + 负 PID，防孙进程残留）。输出累计截断到
 * MAX_COMMAND_OUTPUT_BYTES，仅用于失败时的报错详情。
 */
export function runCommandWithDirectoryQuota(
  options: DirectoryQuotaCommandOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const label = options.label ?? 'Command';
    const child = spawn(options.command, options.args, {
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let output = '';
    let quotaExceeded = false;
    let timedOut = false;
    let monitorError: Error | undefined;
    let settled = false;

    const appendOutput = (chunk: Buffer): void => {
      if (output.length >= MAX_COMMAND_OUTPUT_BYTES) return;
      output += chunk
        .toString()
        .slice(0, MAX_COMMAND_OUTPUT_BYTES - output.length);
    };
    child.stdout?.on('data', appendOutput);
    child.stderr?.on('data', appendOutput);

    const stopProcessGroup = (): void => {
      if (!child.pid) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };

    const monitor = setInterval(() => {
      try {
        if (
          directorySizeUntil(options.watchDir, options.maxBytes) >
          options.maxBytes
        ) {
          quotaExceeded = true;
          stopProcessGroup();
        }
      } catch (error) {
        monitorError =
          error instanceof Error ? error : new Error(String(error));
        stopProcessGroup();
      }
    }, options.pollIntervalMs ?? 50);
    monitor.unref();

    const timeout = setTimeout(() => {
      timedOut = true;
      stopProcessGroup();
    }, options.timeoutMs);
    timeout.unref();

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearInterval(monitor);
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };

    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      try {
        if (
          directorySizeUntil(options.watchDir, options.maxBytes) >
          options.maxBytes
        ) {
          quotaExceeded = true;
        }
      } catch (error) {
        monitorError =
          error instanceof Error ? error : new Error(String(error));
      }
      if (quotaExceeded) {
        finish(
          new Error(
            `${label} exceeds the ${Math.floor(options.maxBytes / 1024 / 1024)} MB size limit`,
          ),
        );
      } else if (timedOut) {
        finish(new Error(`${label} timed out`));
      } else if (monitorError) {
        finish(monitorError);
      } else if (code !== 0) {
        const details = output.trim();
        finish(
          new Error(
            `${label} failed${signal ? ` (${signal})` : ''}${details ? `: ${details}` : ''}`,
          ),
        );
      } else {
        finish();
      }
    });
  });
}

/** AdmZip 把外部属性高位字存 unix mode；按 S_IFMT 掩码比对 S_IFLNK 判断符号链接。 */
function isSymlinkMode(attributes: number): boolean {
  const unixMode = (attributes >>> 16) & 0xffff;
  return (unixMode & 0xf000) === 0xa000;
}

/** 归档条目名白名单式校验：拒绝绝对路径、盘符、`\0` 与 `..` 穿越，返回归一化名。 */
function validateArchiveEntryName(entryName: string): string {
  const normalized = entryName.replace(/\\/g, '/');
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized)
  ) {
    throw new Error('Archive contains an unsafe absolute path');
  }
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => part === '..')) {
    throw new Error('Archive contains a path traversal entry');
  }
  return normalized;
}

/** 落盘后二次校验：lstat 逐项拒绝符号链接，累计文件数与字节数超限即抛错。 */
function assertSafeSkillTree(root: string): void {
  let entries = 0;
  let totalBytes = 0;
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      entries += 1;
      if (entries > MAX_ENTRIES)
        throw new Error('Skill contains too many files');
      const fullPath = path.join(dir, entry.name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        throw new Error('Skill packages cannot contain symbolic links');
      }
      if (stat.isDirectory()) {
        visit(fullPath);
      } else if (stat.isFile()) {
        totalBytes += stat.size;
        if (totalBytes > MAX_EXPANDED_BYTES) {
          throw new Error('Skill package is too large after extraction');
        }
      }
    }
  };
  visit(root);
}

/** 以 SKILL.md 为标记定位技能目录（限深度，跳过 .git / node_modules），
 *  目录名即技能 ID——必须通过 validateSkillId，且全包不得重复。 */
function findSkillDirectories(
  root: string,
): Array<{ id: string; dir: string }> {
  const found = new Map<string, string>();
  const visit = (dir: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH) return;
    const skillFile = path.join(dir, 'SKILL.md');
    if (fs.existsSync(skillFile) && fs.statSync(skillFile).isFile()) {
      const id = path.basename(dir);
      if (!validateSkillId(id)) {
        throw new Error(`Invalid skill directory name: ${id}`);
      }
      if (found.has(id)) throw new Error(`Duplicate skill ID: ${id}`);
      found.set(id, dir);
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        entry.name === '.git' ||
        entry.name === 'node_modules'
      )
        continue;
      visit(path.join(dir, entry.name), depth + 1);
    }
  };
  visit(root, 0);
  if (found.size === 0)
    throw new Error('No directory containing SKILL.md was found');
  return [...found]
    .map(([id, dir]) => ({ id, dir }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * 事务式安装：staging 暂存 →（replace 时）备份同名旧版 → rename 落位 →
 * commit 回调（调用方在此持久化元数据）→ 清理备份。任一步抛错则删除已
 * 落位的新目录、从备份还原旧版，保证目标目录不留半装状态。
 */
export function installSkillDirectoriesTransactionally(
  candidates: Array<{ id: string; dir: string }>,
  targetRoot: string,
  replace: boolean,
  commit?: (installed: string[]) => void,
): string[] {
  fs.mkdirSync(targetRoot, { recursive: true });
  const conflicts = candidates.filter(({ id }) =>
    fs.existsSync(path.join(targetRoot, id)),
  );
  if (conflicts.length > 0 && !replace) {
    throw new Error(
      `Skill already exists: ${conflicts.map(({ id }) => id).join(', ')}`,
    );
  }

  const transactionDir = fs.mkdtempSync(path.join(targetRoot, '.import-'));
  const backups: Array<{ destination: string; backup: string }> = [];
  const installed: string[] = [];
  try {
    for (const candidate of candidates) {
      const staged = path.join(transactionDir, candidate.id);
      fs.cpSync(candidate.dir, staged, { recursive: true, dereference: false });
      assertSafeSkillTree(staged);
    }
    for (const candidate of candidates) {
      const destination = path.join(targetRoot, candidate.id);
      if (fs.existsSync(destination)) {
        const backup = path.join(transactionDir, `.backup-${candidate.id}`);
        fs.renameSync(destination, backup);
        backups.push({ destination, backup });
      }
      fs.renameSync(path.join(transactionDir, candidate.id), destination);
      installed.push(candidate.id);
    }
    commit?.([...installed]);
    for (const { backup } of backups)
      fs.rmSync(backup, { recursive: true, force: true });
    return installed;
  } catch (error) {
    for (const id of installed)
      fs.rmSync(path.join(targetRoot, id), { recursive: true, force: true });
    for (const { destination, backup } of backups) {
      if (fs.existsSync(backup)) fs.renameSync(backup, destination);
    }
    throw error;
  } finally {
    fs.rmSync(transactionDir, { recursive: true, force: true });
  }
}

/**
 * 从 Git 仓库导入技能。URL 先过 validateSafeHttpsUrl / 禁内嵌凭据 /
 * 公网地址解析三道闸；clone 走 pinned 代理并显式禁重定向、file 协议与
 * 子模块（防代理绕过与本地协议注入），ref 白名单字符集，subdirectory
 * 归一化后校验不得逃出仓库根。clone 完成后按 ZIP 同一套标准
 * （assertSafeSkillTree + 事务安装）落盘。
 */
export async function importSkillsFromGit(options: {
  url: string;
  ref?: string;
  subdirectory?: string;
  targetRoot: string;
  replace?: boolean;
  commit?: (result: SkillImportResult) => void;
}): Promise<SkillImportResult> {
  const reason = validateSafeHttpsUrl(options.url);
  if (reason) throw new Error(`Refused Git URL: ${reason}`);
  const parsedUrl = new URL(options.url);
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error('Git URLs containing credentials are not allowed');
  }
  await assertResolvesToPublicAddress(parsedUrl.hostname, 'Git hostname');
  if (options.ref && !/^[\w./-]{1,200}$/.test(options.ref)) {
    throw new Error('Invalid Git ref');
  }
  if (options.subdirectory) {
    const normalized = path.posix.normalize(
      options.subdirectory.replace(/\\/g, '/'),
    );
    if (
      normalized === '..' ||
      normalized.startsWith('../') ||
      path.posix.isAbsolute(normalized)
    ) {
      throw new Error('Invalid Git subdirectory');
    }
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-git-import-'));
  const repoDir = path.join(tempDir, 'repo');
  try {
    const gitProxy = await startPinnedHttpsProxy(parsedUrl.hostname, {
      expectedPort: parsedUrl.port ? Number(parsedUrl.port) : 443,
    });
    const args = [
      '-c',
      `http.proxy=${gitProxy.url}`,
      '-c',
      'http.followRedirects=false',
      '-c',
      'protocol.file.allow=never',
      '-c',
      'submodule.recurse=false',
      'clone',
      '--depth',
      '1',
      '--no-tags',
      '--single-branch',
    ];
    if (options.ref) args.push('--branch', options.ref);
    args.push('--', options.url, repoDir);
    try {
      await runCommandWithDirectoryQuota({
        command: 'git',
        args,
        watchDir: tempDir,
        maxBytes: MAX_GIT_REPOSITORY_BYTES,
        timeoutMs: 60_000,
        label: 'Git repository',
        env: buildPinnedGitEnvironment(gitProxy.url),
      });
    } finally {
      await gitProxy.close();
    }
    const scanRoot = options.subdirectory
      ? path.resolve(repoDir, options.subdirectory)
      : repoDir;
    if (scanRoot !== repoDir && !scanRoot.startsWith(`${repoDir}${path.sep}`)) {
      throw new Error('Git subdirectory escapes the repository');
    }
    if (!fs.existsSync(scanRoot) || !fs.statSync(scanRoot).isDirectory()) {
      throw new Error('Git subdirectory does not exist');
    }
    const candidates = findSkillDirectories(scanRoot);
    for (const candidate of candidates) assertSafeSkillTree(candidate.dir);
    const { stdout } = await execFileAsync('git', [
      '-C',
      repoDir,
      'rev-parse',
      'HEAD',
    ]);
    const version = stdout.trim();
    const installed = installSkillDirectoriesTransactionally(
      candidates,
      options.targetRoot,
      options.replace === true,
      (installedIds) =>
        options.commit?.({
          installed: installedIds,
          sourceUrl: options.url,
          version,
        }),
    );
    return { installed, sourceUrl: options.url, version };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * 从 ZIP 压缩包导入技能：先校验包大小（1B–10MB），逐条目做路径安全与
 * 符号链接检查并按条目头累计解压大小（超限先拒不解压），解压后再跑
 * assertSafeSkillTree 以实际落盘状态兜底，最后事务安装。
 */
export function importSkillsFromZip(options: {
  archive: Buffer;
  archiveName: string;
  targetRoot: string;
  replace?: boolean;
  commit?: (result: SkillImportResult) => void;
}): SkillImportResult {
  if (
    options.archive.byteLength === 0 ||
    options.archive.byteLength > SKILL_ARCHIVE_MAX_FILE_BYTES
  ) {
    throw new Error('ZIP archive must be between 1 byte and 10 MB');
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-zip-import-'));
  try {
    const zip = new AdmZip(options.archive);
    const entries = zip.getEntries();
    if (entries.length === 0 || entries.length > MAX_ENTRIES) {
      throw new Error('ZIP archive has an invalid number of entries');
    }
    let expandedBytes = 0;
    for (const entry of entries) {
      validateArchiveEntryName(entry.entryName);
      if (isSymlinkMode(entry.attr))
        throw new Error('ZIP archives cannot contain symbolic links');
      expandedBytes += entry.header.size;
      if (expandedBytes > MAX_EXPANDED_BYTES) {
        throw new Error('ZIP archive is too large after extraction');
      }
    }
    zip.extractAllTo(tempDir, true, false);
    assertSafeSkillTree(tempDir);
    const candidates = findSkillDirectories(tempDir);
    const installed = installSkillDirectoriesTransactionally(
      candidates,
      options.targetRoot,
      options.replace === true,
      (installedIds) =>
        options.commit?.({
          installed: installedIds,
          sourceUrl: options.archiveName,
        }),
    );
    return { installed, sourceUrl: options.archiveName };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
