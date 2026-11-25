import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

// THESIS-16 D-U1/D-U2/D-U3 ①：单账号个人版界面不再出现多用户角色与成员访问
// 措辞；IM 侧的“允许成员”指群成员，属于保留的访问控制，作为正控制锁定。
const root = process.cwd();
const sourceRoot = path.join(root, 'web/src');

function listSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(absolute));
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts') &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      files.push(absolute);
    }
  }
  return files;
}

// 与 frontend-reachability-contract 相同的注释剥离口径：只在行首或空白/{ 后
// 识别注释定界符，避免把字符串里的 https:// 或 image/* 误删。注释不参与界面
// 文案门禁（issue 非目标允许保留 App.tsx / UncertainOutboxCard.tsx 的注释）。
function stripComments(source: string): string {
  return source
    .replace(/(^|[\s{])\/\*[\s\S]*?\*\//gm, '$1')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

const FORBIDDEN_WORDING = [
  '管理员',
  '普通成员',
  '成员访问',
  '共享给成员',
  '成员任务',
];

describe('personal-edition UI wording contract', () => {
  test('web source exposes no multi-user role or member-access wording', () => {
    const offenders = listSourceFiles(sourceRoot).flatMap((file) => {
      const source = stripComments(fs.readFileSync(file, 'utf8'));
      return FORBIDDEN_WORDING.filter((token) => source.includes(token)).map(
        (token) => `${path.relative(root, file)}: ${token}`,
      );
    });

    expect(offenders).toEqual([]);
  });

  test('IM-side member wording is retained as a positive control', () => {
    expect(read('web/src/components/chat/ImBindingDialog.tsx')).toContain(
      '所有允许成员',
    );
    expect(read('web/src/constants/im.ts')).toContain('响应允许成员的所有消息');
  });

  test('MCP member access control is hidden while API fields stay', () => {
    for (const file of [
      'web/src/components/mcp-servers/AddMcpServerDialog.tsx',
      'web/src/components/mcp-servers/McpServerDetail.tsx',
    ]) {
      const source = read(file);
      expect(source).not.toContain('memberAccess');
      expect(source).not.toContain('成员访问');
      expect(source).not.toContain('共享给成员');
    }

    // D-U2 ①：只隐藏界面控件，接口与存储字段保留，存量值不受影响。
    expect(read('web/src/stores/mcp-servers.ts')).toContain('memberAccess');
    expect(read('src/routes/mcp-servers.ts')).toContain('memberAccess');
  });

  test('rewritten surfaces use functional wording instead of empty text', () => {
    expect(read('web/src/pages/SetupPage.tsx')).toContain('创建账号');
    expect(
      read('web/src/components/settings/SystemSettingsSection.tsx'),
    ).toContain('纯宿主机模式');
    expect(
      read('web/src/components/settings/ProfileSection.tsx'),
    ).not.toContain("role === 'admin'");
  });
});
