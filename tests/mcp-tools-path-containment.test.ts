import path from 'node:path';
import { describe, expect, test } from 'vitest';

import { isPathWithinWorkspaceRoot } from '../container/agent-runner/src/utils.js';

// ISSUE-05 §4：mcp-tools.ts 三处（send_image / upload_file 绝对与相对分支）
// 各自内联的 safeRoot + startsWith 路径包含检查收敛为本函数。语义保持不变：
// 纯字符串前缀比较（resolved 已由调用方 path.resolve），不做 realpath/符号
// 链接解析——符号链接的当前行为在下方用例中显式记录。
const ROOT = '/ws/group1';

describe('isPathWithinWorkspaceRoot (ISSUE-05 §4)', () => {
  test('accepts the workspace root itself and files inside it', () => {
    expect(isPathWithinWorkspaceRoot(ROOT, ROOT)).toBe(true);
    expect(isPathWithinWorkspaceRoot('/ws/group1/report.pdf', ROOT)).toBe(true);
    expect(isPathWithinWorkspaceRoot('/ws/group1/sub/dir/file.txt', ROOT)).toBe(
      true,
    );
  });

  test('rejects parent-directory traversal (..)', () => {
    // 契约：调用方先 path.resolve 再传入（mcp-tools 三处调用点均如此），
    // 此处模拟真实调用方式——resolve 把 ../ 规范化掉后即逃出 root 字符串前缀。
    expect(
      isPathWithinWorkspaceRoot(path.resolve('/ws/group1/../../secret'), ROOT),
    ).toBe(false); // path.resolve → '/secret'
    expect(
      isPathWithinWorkspaceRoot(
        path.resolve('/ws/group1', '../../secret'),
        ROOT,
      ),
    ).toBe(false); // path.resolve → '/secret'
    expect(isPathWithinWorkspaceRoot('/ws/etc/passwd', ROOT)).toBe(false);
    expect(isPathWithinWorkspaceRoot('/etc/passwd', ROOT)).toBe(false);
  });

  test('rejects sibling directories that merely share a name prefix', () => {
    // 前缀绕过防护：/ws/group10 不是 /ws/group1 的子路径。
    expect(isPathWithinWorkspaceRoot('/ws/group10/x.png', ROOT)).toBe(false);
    expect(isPathWithinWorkspaceRoot('/ws/group1-backup/x.png', ROOT)).toBe(
      false,
    );
  });

  test('treats trailing-separator and bare roots identically', () => {
    const rootWithSep = `${ROOT}/`;
    expect(isPathWithinWorkspaceRoot('/ws/group1/x.png', rootWithSep)).toBe(
      true,
    );
    // root 本身带尾分隔符时，"等于 root" 的判定按去尾比较，行为与裸 root 一致。
    expect(isPathWithinWorkspaceRoot(rootWithSep, rootWithSep)).toBe(true);
    expect(isPathWithinWorkspaceRoot('/ws/group10/x.png', rootWithSep)).toBe(
      false,
    );
  });

  test('current behavior: pure string comparison, symlinks are not resolved', () => {
    // 显式记录当前语义：不做 realpath 解析。一个位于 root 内的符号链接路径
    // （即使其链接目标指向 root 外部）会按字符串路径放行；反之，指向 root 内
    // 的外部路径字符串仍被拒。若未来引入 realpath 收紧，请同步更新本用例。
    expect(isPathWithinWorkspaceRoot('/ws/group1/link', ROOT)).toBe(true);
    expect(isPathWithinWorkspaceRoot('/outside/link-to-inside', ROOT)).toBe(
      false,
    );
  });
});
