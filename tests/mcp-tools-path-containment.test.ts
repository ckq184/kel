import path from 'node:path';
import { describe, expect, test } from 'vitest';

import { isPathWithinWorkspaceRoot } from '../container/agent-runner/src/utils.js';

// ISSUE-05 §4：mcp-tools.ts 三处（send_image / upload_file 绝对与相对分支）
// 各自内联的 safeRoot + startsWith 路径包含检查收敛为本函数。语义保持不变：
// 纯字符串前缀比较（resolved 已由调用方 path.resolve），不做 realpath/符号
// 链接解析——符号链接的当前行为在下方用例中显式记录。
//
// ISSUE-15：夹具原为 POSIX 字面量，Windows 下与实现按 path.sep 的前缀比较
// 互斥必红；改为 join(path.sep) 逐平台原生构造，被测语义与断言方向不变。
const p = (...parts: string[]) => parts.join(path.sep);
const ROOT = p('', 'ws', 'group1');

describe('isPathWithinWorkspaceRoot (ISSUE-05 §4)', () => {
  test('accepts the workspace root itself and files inside it', () => {
    expect(isPathWithinWorkspaceRoot(ROOT, ROOT)).toBe(true);
    expect(
      isPathWithinWorkspaceRoot(p('', 'ws', 'group1', 'report.pdf'), ROOT),
    ).toBe(true);
    expect(
      isPathWithinWorkspaceRoot(
        p('', 'ws', 'group1', 'sub', 'dir', 'file.txt'),
        ROOT,
      ),
    ).toBe(true);
  });

  test('rejects parent-directory traversal (..)', () => {
    // 契约：调用方先 path.resolve 再传入（mcp-tools 三处调用点均如此），
    // 此处模拟真实调用方式——resolve 把 ../ 规范化掉后即逃出 root 字符串
    // 前缀（posix 得 '/secret'，win32 得盘符根 'C:\secret'）。
    expect(
      isPathWithinWorkspaceRoot(
        path.resolve(p('', 'ws', 'group1', '..', '..', 'secret')),
        ROOT,
      ),
    ).toBe(false);
    expect(
      isPathWithinWorkspaceRoot(
        path.resolve(ROOT, p('..', '..', 'secret')),
        ROOT,
      ),
    ).toBe(false);
    expect(isPathWithinWorkspaceRoot(p('', 'ws', 'etc', 'passwd'), ROOT)).toBe(
      false,
    );
    expect(isPathWithinWorkspaceRoot(p('', 'etc', 'passwd'), ROOT)).toBe(false);
  });

  test('rejects sibling directories that merely share a name prefix', () => {
    // 前缀绕过防护：/ws/group10 不是 /ws/group1 的子路径。
    expect(
      isPathWithinWorkspaceRoot(p('', 'ws', 'group10', 'x.png'), ROOT),
    ).toBe(false);
    expect(
      isPathWithinWorkspaceRoot(p('', 'ws', 'group1-backup', 'x.png'), ROOT),
    ).toBe(false);
  });

  test('treats trailing-separator and bare roots identically', () => {
    const rootWithSep = `${ROOT}${path.sep}`;
    expect(
      isPathWithinWorkspaceRoot(p('', 'ws', 'group1', 'x.png'), rootWithSep),
    ).toBe(true);
    // root 本身带尾分隔符时，"等于 root" 的判定按去尾比较，行为与裸 root 一致。
    expect(isPathWithinWorkspaceRoot(rootWithSep, rootWithSep)).toBe(true);
    expect(
      isPathWithinWorkspaceRoot(p('', 'ws', 'group10', 'x.png'), rootWithSep),
    ).toBe(false);
  });

  test('current behavior: pure string comparison, symlinks are not resolved', () => {
    // 显式记录当前语义：不做 realpath 解析。一个位于 root 内的符号链接路径
    // （即使其链接目标指向 root 外部）会按字符串路径放行；反之，指向 root 内
    // 的外部路径字符串仍被拒。若未来引入 realpath 收紧，请同步更新本用例。
    expect(isPathWithinWorkspaceRoot(p('', 'ws', 'group1', 'link'), ROOT)).toBe(
      true,
    );
    expect(
      isPathWithinWorkspaceRoot(p('', 'outside', 'link-to-inside'), ROOT),
    ).toBe(false);
  });
});
