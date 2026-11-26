/**
 * ISSUE-12 波 7 单元 7.3：路由测试用户 helper 收敛（原 13 个测试文件各自
 * 内联的 asUser/createUser/seedUser 变体 → 单点具名导出）。
 * 各文件的 afterEach env 清理保留在原文件（各自删的键集不同）。
 *
 * THESIS-20：系统只剩管理员一个角色，helper 不再接受 role 参数，注入的
 * 角色恒为 admin。
 *
 * 变体对应（立项计划三变体 + 实测补充）：
 * - asRouteTestUser：变体 1（CKQCLAW_TEST_USER_ID/ROLE；host-mount 扩展
 *   第二参 status，仅在显式传入时设置 CKQCLAW_TEST_USER_STATUS——
 *   变体 1 原文件从不触碰该键）；
 * - asOwnerProfileRouteUser：变体 2（CKQCLAW_OWNER_PROFILE_ROUTE_*）；
 * - asSystemSettingsTestUser：变体 3（CKQCLAW_TEST_ROLE）；
 * - asInteractionTestUser：计划外第 4 迷你变体（CKQCLAW_INTERACTION_TEST_USER，
 *   基线后新增，台账留痕）；
 * - createTestUserRow：createUser/seedUser 同体收敛（db 经参数注入——测试
 *   需先设 env 再动态 import db，helper 顶层静态 import 会破坏该顺序）。
 */

export function asRouteTestUser(
  userId: string,
  status?: 'active' | 'disabled',
): void {
  process.env.CKQCLAW_TEST_USER_ID = userId;
  process.env.CKQCLAW_TEST_USER_ROLE = 'admin';
  if (status !== undefined) process.env.CKQCLAW_TEST_USER_STATUS = status;
}

export function asOwnerProfileRouteUser(id: string): void {
  process.env.CKQCLAW_OWNER_PROFILE_ROUTE_USER = id;
  process.env.CKQCLAW_OWNER_PROFILE_ROUTE_ROLE = 'admin';
}

export function asSystemSettingsTestUser(): void {
  process.env.CKQCLAW_TEST_ROLE = 'admin';
}

export function asInteractionTestUser(id: string): void {
  process.env.CKQCLAW_INTERACTION_TEST_USER = id;
}

export function asMemoryRouteTestUser(id: string): void {
  process.env.CKQCLAW_MEMORY_TEST_USER = id;
  process.env.CKQCLAW_MEMORY_TEST_ROLE = 'admin';
}

interface TestUserDb {
  createUser(row: {
    id: string;
    username: string;
    password_hash: string;
    display_name: string;
    role: 'admin';
    status: string;
    created_at: string;
    updated_at: string;
    must_change_password: boolean;
  }): unknown;
}

export function createTestUserRow(db: TestUserDb, id: string): void {
  const now = new Date().toISOString();
  db.createUser({
    id,
    username: id,
    password_hash: 'hash',
    display_name: id,
    role: 'admin',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
}
