import type { DbMigrationContext } from './context.js';
import { enforceCkqclawOwnerAddressCanonicalInvariant } from '../memory-store.js';
import {
  bindOwnerProfileDatabase,
  createOwnerProfileSchema,
  reconcileLegacyOwnerProfileMemory,
} from '../owner-profile-store.js';

// ISSUE-12 波 3 单元 3.2：认证表族与 Owner Profile 生命周期自 src/db.ts
// 原文搬运（原 db.ts 794-883：users/user_sessions/user_pinned_groups
// 建表，及 v65→v66 CKQClaw Owner Profile 的 create/bind 与
// rawSchemaVersionBeforeInit < 66 门控 else 分支）。
// 搬运体逐字节一致，唯一改写是同名解构 const { db,
// rawSchemaVersionBeforeInit } = ctx（调用点零改动）。owner-profile 与
// memory 两 store 的四函数为 db.ts 既有 import，本模块改自其源模块直引
// （无环）。门控表达式原文保留（!== null && Number(...) < 66），全新库
// 走 else 分支的既有语义不变；计划表 794-866 外的 868-883（v65→v66 块）
// 为行界缺口段，按主题并入本单元，提交信息留痕。

export function ensureAuthTables(ctx: DbMigrationContext): void {
  const { db, rawSchemaVersionBeforeInit } = ctx;
  // Auth tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'admin',
      status TEXT NOT NULL DEFAULT 'active',
      permissions TEXT NOT NULL DEFAULT '[]',
      must_change_password INTEGER NOT NULL DEFAULT 0,
      disable_reason TEXT,
      notes TEXT,
      avatar_emoji TEXT,
      avatar_color TEXT,
      default_require_mention INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_users_status_role ON users(status, role);
    CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);
  `);

  // User pinned groups (per-user workspace pinning)
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_pinned_groups (
      user_id TEXT NOT NULL,
      jid TEXT NOT NULL,
      pinned_at TEXT NOT NULL,
      PRIMARY KEY (user_id, jid)
    );
  `);

  // v65 -> v66: CKQClaw Owner Profile remains a reserved Workspace Memory
  // item; this table tracks only its one-shot onboarding lifecycle. Duplicate
  // legacy items must be reconciled before the reserved-key unique index is
  // installed.
  createOwnerProfileSchema(db);
  bindOwnerProfileDatabase(db);
  if (
    rawSchemaVersionBeforeInit !== null &&
    Number(rawSchemaVersionBeforeInit) < 66
  ) {
    reconcileLegacyOwnerProfileMemory();
  } else {
    // Fresh and already-v66 databases need the structural invariant, but must
    // not re-run legacy sentinel inference on every normal restart.
    enforceCkqclawOwnerAddressCanonicalInvariant();
  }
}
