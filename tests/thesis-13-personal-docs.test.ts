import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('THESIS-13 personal product positioning', () => {
  test('README, CLAUDE.md and AGENTS.md no longer describe a multi-user product', () => {
    for (const file of ['README.md', 'CLAUDE.md', 'AGENTS.md']) {
      expect(read(file), file).not.toContain('多用户');
    }

    const readme = read('README.md');
    expect(readme).toContain('面向个人的自托管 AI Agent 工作台');
    expect(readme).toContain('个人 Agent 工作台');

    const claude = read('CLAUDE.md');
    expect(claude).toContain('自托管、个人 Agent 工作台');
  });

  test('README and docs/API.md link to the personal access-boundary document', () => {
    const readme = read('README.md');
    expect(readme).toContain('个人版访问边界');
    expect(readme).toMatch(/\[[^\]]*\]\(docs\/ACL-MATRIX\.md\)/);
    expect(readme).not.toContain(
      '用户、Workspace、Channel、Host 与任务权限矩阵',
    );

    const api = read('docs/API.md');
    expect(api).toContain('个人版访问边界');
    expect(api).toMatch(/\[[^\]]*\]\(ACL-MATRIX\.md\)/);
    expect(api).not.toContain('[ACL 权限矩阵](ACL-MATRIX.md)');
  });
});

describe('THESIS-13 personal access-boundary document', () => {
  const acl = read('docs/ACL-MATRIX.md');

  test('is retitled and keeps the two retained layers', () => {
    expect(acl).toMatch(/^# CKQClaw 个人版访问边界$/m);
    expect(acl).toContain('第一层：登录会话');
    expect(acl).toContain('第二层：IM 侧访问控制');
  });

  test('drops removed permission identifiers, routes and surfaces', () => {
    for (const token of [
      'manage_system_config',
      'manage_users',
      'manage_invites',
      'view_audit_log',
      'manage_group_env',
      'requirePermission',
      'systemConfigMiddleware',
      'usersManageMiddleware',
      'inviteManageMiddleware',
      'auditViewMiddleware',
      '/api/auth/register',
      '/api/admin',
      '/api/usage',
      '/api/pricing',
      '模型单价',
    ]) {
      expect(acl, token).not.toContain(token);
    }

    // 不保留这些层的章节；正文里说明“已下线”仍允许。
    expect(acl).not.toMatch(/^##+ .*(用户管理|邀请|审计)/m);
  });

  test('documents the retained session, ownership and IM boundaries', () => {
    for (const token of [
      'authMiddleware',
      'adminRoleMiddleware',
      'hasHostExecutionPermission',
      'canExecuteOnHost',
      'canAccessGroup',
      'canModifyGroup',
      'canDeleteGroup',
      'task-acl',
      'owner_im_id',
      'audience_mode',
      'activation_mode',
      'im-audience-policy',
      'im-command-utils',
      'Origin',
    ]) {
      expect(acl, token).toContain(token);
    }
  });

  test('keeps the retained deep-defense boundaries', () => {
    for (const token of [
      'Workspace Memory',
      'delete-impact',
      'adminHostOnlyMode',
    ]) {
      expect(acl, token).toContain(token);
    }
  });
});
