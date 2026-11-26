import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { hashPassword } from './auth.js';
import {
  initDatabase,
  getUserByUsername,
  updateUserFields,
  deleteUserSessionsByUserId,
} from './db.js';

const USAGE = 'Usage: npm run reset:admin -- <username> <new_password>';

export class ResetAdminError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_password' | 'user_not_found',
  ) {
    super(message);
    this.name = 'ResetAdminError';
  }
}

/**
 * Reset the password of an existing CKQClaw account. Exported so the behavior
 * is covered by tests; the CLI wrapper below owns argv parsing and exit codes.
 */
export async function resetAdminAccount(
  username: string,
  nextPassword: string,
): Promise<void> {
  if (!nextPassword || nextPassword.trim().length < 8) {
    throw new ResetAdminError(
      'new_password must be at least 8 characters',
      'invalid_password',
    );
  }

  const existing = getUserByUsername(username);
  if (!existing) {
    // A personal installation has exactly one account. Creating a second one
    // here is what reset:admin used to do; the only supported recovery path is
    // resetting the existing account.
    throw new ResetAdminError(
      `User not found: ${username}. reset:admin only resets the existing account.`,
      'user_not_found',
    );
  }

  const passwordHash = await hashPassword(nextPassword);
  updateUserFields(existing.id, {
    role: 'admin',
    status: 'active',
    password_hash: passwordHash,
    disable_reason: null,
    deleted_at: null,
  });
  deleteUserSessionsByUserId(existing.id);
}

async function main(): Promise<void> {
  initDatabase();

  // 与 routes/auth.ts / routes/admin.ts 一致：username 小写存储，避免
  // mixed-case 创建出登录路径永远查不到的孤儿行（login 走 toLowerCase 后
  // 命中不到原 mixed-case 行）。
  const username = (process.argv[2] || 'admin').trim().toLowerCase();
  try {
    await resetAdminAccount(username, process.argv[3] ?? '');
  } catch (error) {
    if (!(error instanceof ResetAdminError)) throw error;
    if (error.code === 'invalid_password') console.error(USAGE);
    console.error(error.message);
    process.exit(1);
  }
  console.log(`[OK] Reset admin account: ${username}`);
}

function invokedAsScript(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return (
      fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (invokedAsScript()) {
  void main();
}
