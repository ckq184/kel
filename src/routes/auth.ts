// Authentication routes

import fs from 'fs';
import { zodBadRequest } from '../validation-response.js';
import { readFile } from 'fs/promises';
import path from 'path';
import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { getClientIp } from '../utils.js';
import { avatarUploadBodyLimit } from '../http-upload-policy.js';
import {
  AVATARS_DIR,
  reapAvatarFiles,
  storeAvatarUpload,
} from '../avatar-upload.js';
import {
  LoginSchema,
  ProfileUpdateSchema,
  ChangePasswordSchema,
} from '../schemas.js';
import {
  getUserByUsername,
  getUserById,
  createInitialAdminUser,
  createUserSession,
  deleteUserSession,
  deleteUserSessionsByUserId,
  updateUserFields,
  getUserSessions,
  getUserCount,
  ensureUserHomeGroup,
} from '../db.js';
import {
  getEnabledProviders,
  getFeishuProviderConfigWithSource,
  getAppearanceConfig,
} from '../runtime-config.js';
import {
  verifyPassword,
  hashPassword,
  generateSessionToken,
  sessionExpiresAt,
  checkLoginRateLimit,
  recordLoginAttempt,
  clearLoginAttempts,
  validateUsername,
  validatePassword,
  generateUserId,
} from '../auth.js';
import type { AuthUser, User, UserPublic } from '../types.js';
import { logger } from '../logger.js';
import {
  invalidateSessionCache,
  invalidateUserSessions,
} from '../web-context.js';
import { getSystemSettings } from '../runtime-config.js';

const authRoutes = new Hono<{ Variables: Variables }>();

// --- Helper Functions ---

// Cookie helpers live in auth.ts (single source of truth, also used by middleware).
import { setSessionCookie, clearSessionCookie } from '../auth.js';
export { setSessionCookie, clearSessionCookie };

export function isUsernameConflictError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.includes('UNIQUE constraint failed: users.username')
  );
}

export function toUserPublic(u: User): UserPublic {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    role: u.role,
    status: u.status,
    disable_reason: u.disable_reason,
    notes: u.notes,
    avatar_emoji: u.avatar_emoji ?? null,
    avatar_color: u.avatar_color ?? null,
    avatar_url: u.avatar_url ?? null,
    default_require_mention: u.default_require_mention,
    created_at: u.created_at,
    last_login_at: u.last_login_at,
    last_active_at: null,
    deleted_at: u.deleted_at,
  };
}

function buildSetupStatus() {
  // Check ALL enabled providers, not just the first one.
  // V3→V4 migration can produce empty providers that sort before real ones,
  // causing getClaudeProviderConfig() (first-match) to return an unconfigured provider.
  // THESIS-02：接口封口后只认第三方配置——有 Base URL，且有 Auth Token
  // 或 API Key（anthropicApiKey 是 runner 第三方分支的共用密钥，不是
  // 官方专用）。官方两个字段不再算作已配置。
  const providers = getEnabledProviders();
  const claudeConfigured = providers.some((p) => {
    const hasBaseUrl = !!p.anthropicBaseUrl?.trim();
    const hasCredential = !!(
      p.anthropicAuthToken?.trim() || p.anthropicApiKey?.trim()
    );
    return hasBaseUrl && hasCredential;
  });
  const { source: feishuSource } = getFeishuProviderConfigWithSource();
  const feishuConfigured = feishuSource !== 'none';
  const providerSetupSkipped = getSystemSettings().providerSetupSkipped;

  return {
    needsSetup: !claudeConfigured && !providerSetupSkipped,
    claudeConfigured,
    feishuConfigured,
    providerSetupSkipped,
  };
}

// --- Routes ---

// Public: check if system is initialized (any user exists)
authRoutes.get('/status', (c) => {
  const initialized = getUserCount(true) > 0;
  return c.json({ initialized });
});

// Public: initial admin setup (only when no users exist)
authRoutes.post('/setup', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { username: rawUsername, password } = body as {
    username?: string;
    password?: string;
  };

  if (!rawUsername || !password) {
    return c.json({ error: 'Username and password are required' }, 400);
  }

  const usernameError = validateUsername(rawUsername);
  if (usernameError) return c.json({ error: usernameError }, 400);
  // 归一化大小写（与 login 一致）。
  const username = rawUsername.toLowerCase();

  const passwordError = validatePassword(password);
  if (passwordError) return c.json({ error: passwordError }, 400);

  const now = new Date().toISOString();
  const userId = generateUserId();
  const passwordHash = await hashPassword(password);
  const ip = getClientIp(c);
  const ua = c.req.header('user-agent') || null;

  const createResult = createInitialAdminUser({
    id: userId,
    username,
    password_hash: passwordHash,
    display_name: username,
    role: 'admin',
    status: 'active',
    notes: 'Initial admin (setup wizard)',
    created_at: now,
    updated_at: now,
  });
  if (!createResult.ok) {
    if (createResult.reason === 'already_initialized') {
      return c.json({ error: 'System already initialized' }, 403);
    }
    return c.json({ error: 'Username already taken' }, 400);
  }

  // Create admin home group (web:main, folder=main, host mode)
  try {
    ensureUserHomeGroup(userId, 'admin', username);
  } catch (err) {
    logger.warn(
      { err, userId },
      'Failed to create admin home group during setup',
    );
  }

  // Auto-login
  const token = generateSessionToken();
  createUserSession({
    id: token,
    user_id: userId,
    ip_address: ip,
    user_agent: ua,
    created_at: now,
    expires_at: sessionExpiresAt(),
    last_active_at: now,
  });

  const newUser = getUserById(userId)!;

  return new Response(
    JSON.stringify({
      success: true,
      user: toUserPublic(newUser),
      setupStatus: buildSetupStatus(),
    }),
    {
      status: 201,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': setSessionCookie(c, token),
      },
    },
  );
});

authRoutes.post('/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = LoginSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  // Username 归一化（与 setup 一致）。
  const username = validation.data.username.toLowerCase();
  const { password } = validation.data;
  const ip = getClientIp(c);
  const ua = c.req.header('user-agent') || null;

  // Rate limiting
  const { maxLoginAttempts, loginLockoutMinutes } = getSystemSettings();
  const rateCheck = checkLoginRateLimit(
    username,
    ip,
    maxLoginAttempts,
    loginLockoutMinutes,
  );
  if (!rateCheck.allowed) {
    return c.json(
      {
        error: `Too many login attempts. Try again in ${rateCheck.retryAfterSeconds}s`,
      },
      429,
    );
  }

  const user = getUserByUsername(username);

  // Constant-time: always run bcrypt compare even if user doesn't exist (prevents timing attacks)
  // 使用运行时生成的合法 bcrypt hash，确保 bcrypt.compare 不会抛异常
  const DUMMY_HASH =
    '$2b$12$GBXvNon/zJbUI4jtleGnP.YX03zXP5eSXjppo7a3vyWEUK/2YwdP.';
  let passwordMatch: boolean;
  try {
    passwordMatch = await verifyPassword(
      password,
      user ? user.password_hash : DUMMY_HASH,
    );
  } catch {
    // 如果 hash 格式异常，视为不匹配，不泄漏内部错误
    passwordMatch = false;
  }

  if (!user || user.status !== 'active' || !passwordMatch) {
    recordLoginAttempt(username, ip);
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  // Success — create session
  const token = generateSessionToken();
  const now = new Date().toISOString();
  createUserSession({
    id: token,
    user_id: user.id,
    ip_address: ip,
    user_agent: ua,
    created_at: now,
    expires_at: sessionExpiresAt(),
    last_active_at: now,
  });

  clearLoginAttempts(username, ip);
  updateUserFields(user.id, { last_login_at: now });

  // Ensure user has a home group (backfill for existing users)
  try {
    ensureUserHomeGroup(user.id, user.role, user.username);
  } catch (err) {
    // Don't block login if home group creation fails
    logger.warn(
      { err, userId: user.id },
      'Failed to ensure home group during login',
    );
  }

  const updatedUser = getUserById(user.id) ?? user;
  const setupStatus =
    updatedUser.role === 'admin' ? buildSetupStatus() : undefined;

  return new Response(
    JSON.stringify({
      success: true,
      user: toUserPublic(updatedUser),
      setupStatus,
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': setSessionCookie(c, token),
      },
    },
  );
});

authRoutes.post('/logout', authMiddleware, (c) => {
  const sessionId = c.get('sessionId');
  deleteUserSession(sessionId);
  invalidateSessionCache(sessionId);

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': clearSessionCookie(c),
    },
  });
});

authRoutes.get('/me', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  const fullUser = getUserById(authUser.id);
  if (!fullUser) return c.json({ error: 'User not found' }, 404);

  const userPublic = toUserPublic(fullUser);
  const appearance = getAppearanceConfig();

  // Per-user identity must never be cached by intermediaries (proxies, CDNs)
  // or browser HTTP cache.  PWA service worker explicitly opts in via its
  // own cache strategy (NetworkFirst + auth-store delete on login/logout).
  c.header('Cache-Control', 'private, no-store');

  // Admin users get setup status for the onboarding wizard
  if (fullUser.role === 'admin') {
    return c.json({
      user: userPublic,
      appearance,
      setupStatus: buildSetupStatus(),
    });
  }

  return c.json({ user: userPublic, appearance });
});

authRoutes.put('/profile', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = ProfileUpdateSchema.safeParse(body);
  if (!validation.success) {
    return zodBadRequest(c, validation.error, 'request-format');
  }

  const user = c.get('user') as AuthUser;
  const fullUser = getUserById(user.id);
  if (!fullUser) return c.json({ error: 'User not found' }, 404);

  const updates: Parameters<typeof updateUserFields>[1] = {};
  if (validation.data.username !== undefined) {
    const usernameError = validateUsername(validation.data.username);
    if (usernameError) return c.json({ error: usernameError }, 400);
    // 大小写归一化（与 login / setup 一致）。
    const newUsername = validation.data.username.toLowerCase();
    if (newUsername !== fullUser.username) {
      const existed = getUserByUsername(newUsername);
      if (existed && existed.id !== fullUser.id) {
        return c.json({ error: 'Username already taken' }, 409);
      }
    }
    updates.username = newUsername;
  }
  if (validation.data.display_name !== undefined) {
    updates.display_name = validation.data.display_name;
  }
  if (validation.data.avatar_emoji !== undefined) {
    updates.avatar_emoji = validation.data.avatar_emoji;
  }
  if (validation.data.avatar_color !== undefined) {
    updates.avatar_color = validation.data.avatar_color;
  }
  if (validation.data.avatar_url !== undefined) {
    updates.avatar_url = validation.data.avatar_url;
  }
  if (validation.data.default_require_mention !== undefined) {
    updates.default_require_mention = validation.data.default_require_mention;
  }
  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  try {
    updateUserFields(user.id, updates);
  } catch (err) {
    if (isUsernameConflictError(err)) {
      return c.json({ error: 'Username already taken' }, 409);
    }
    throw err;
  }
  const updated = getUserById(user.id)!;
  return c.json({ success: true, user: toUserPublic(updated) });
});

authRoutes.put('/password', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = ChangePasswordSchema.safeParse(body);
  if (!validation.success) {
    return zodBadRequest(c, validation.error, 'request-format');
  }

  const user = c.get('user') as AuthUser;
  const fullUser = getUserById(user.id);
  if (!fullUser) return c.json({ error: 'User not found' }, 404);

  const match = await verifyPassword(
    validation.data.current_password,
    fullUser.password_hash,
  );
  if (!match) return c.json({ error: 'Current password is incorrect' }, 401);
  if (validation.data.current_password === validation.data.new_password) {
    return c.json(
      { error: 'New password must be different from current password' },
      400,
    );
  }

  const passwordError = validatePassword(validation.data.new_password);
  if (passwordError) return c.json({ error: passwordError }, 400);

  const newHash = await hashPassword(validation.data.new_password);
  updateUserFields(user.id, {
    password_hash: newHash,
  });

  // Revoke all existing sessions for this user
  invalidateUserSessions(user.id);
  deleteUserSessionsByUserId(user.id);

  // Create a fresh session for the current request
  const now = new Date().toISOString();
  const ip = getClientIp(c);
  const ua = c.req.header('user-agent') || null;
  const newToken = generateSessionToken();
  createUserSession({
    id: newToken,
    user_id: user.id,
    ip_address: ip,
    user_agent: ua,
    created_at: now,
    expires_at: sessionExpiresAt(),
    last_active_at: now,
  });

  const updated = getUserById(user.id)!;
  return new Response(
    JSON.stringify({ success: true, user: toUserPublic(updated) }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': setSessionCookie(c, newToken),
      },
    },
  );
});

authRoutes.get('/sessions', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const currentSessionId = c.get('sessionId');
  const sessions = getUserSessions(user.id);
  return c.json({
    sessions: sessions.map((s) => ({
      shortId: s.id.slice(0, 8),
      ip_address: s.ip_address,
      user_agent: s.user_agent,
      created_at: s.created_at,
      last_active_at: s.last_active_at,
      is_current: s.id === currentSessionId,
    })),
  });
});

authRoutes.delete('/sessions/:id', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const targetId = c.req.param('id');
  const sessions = getUserSessions(user.id);
  // Support both full token and shortId (first 8 chars) for lookup
  const target = sessions.find(
    (s) => s.id === targetId || s.id.slice(0, 8) === targetId,
  );
  if (!target) return c.json({ error: 'Session not found' }, 404);

  deleteUserSession(target.id);
  invalidateSessionCache(target.id);
  return c.json({ success: true });
});

// --- Avatar Upload ---

authRoutes.post('/avatar', authMiddleware, avatarUploadBodyLimit, async (c) => {
  const user = c.get('user') as AuthUser;

  // ISSUE-09: users.ai_avatar_url 已随死列下线——AI 头像走
  // /api/config/appearance/avatar（appearance.json，独立目录与前缀，不受
  // 本路由清理影响）。此路由只服务当前登录用户头像；旧 `target=ai` 调用方
  // 已不存在，显式拒绝未知 target 而不是静默当 user 处理。
  const target = c.req.query('target');
  if (target !== undefined && target !== 'user') {
    return c.json(
      {
        error:
          'Unknown avatar target. Use /api/config/appearance/avatar for the AI avatar.',
      },
      400,
    );
  }

  const current = getUserById(user.id);
  const currentFilename = current?.avatar_url
    ? current.avatar_url.replace(/^\/api\/auth\/avatars\//, '')
    : null;

  // Shared validation + write pipeline (ISSUE-11 B9); this route keeps the
  // user auth and the per-user filename prefix. ISSUE-09 removed the AI
  // target, so the prefix is always the user's own.
  const stored = await storeAvatarUpload(c.req, `${user.id}-user-`);
  if (!stored.ok) {
    return c.json({ error: stored.error }, stored.status);
  }
  const avatarUrl = stored.avatarUrl;

  // Reap this user's stale avatar files: same-target leftovers, legacy
  // `${user.id}-{hex}` files (uploaded before the user- prefix), and legacy
  // `${user.id}-ai-` files whose DB url column no longer exists — EXCEPT the
  // file we just wrote and the one the user avatar field still references.
  // The AI avatar uploaded via /api/config/appearance/avatar lives in a
  // different directory with a different prefix and is never touched here.
  try {
    reapAvatarFiles({
      prefix: `${user.id}-`,
      keep: [stored.filename, currentFilename].filter((x): x is string => !!x),
    });
  } catch {
    /* ignore */
  }

  updateUserFields(user.id, { avatar_url: avatarUrl });

  const updated = getUserById(user.id)!;
  return c.json({ success: true, avatarUrl, user: toUserPublic(updated) });
});

// Serve avatar files (public, no auth required)
authRoutes.get('/avatars/:filename', async (c) => {
  const filename = c.req.param('filename');

  // Security: only allow simple filenames (no path traversal)
  if (!filename || /[/\\]/.test(filename) || filename.includes('..')) {
    return c.json({ error: 'Invalid filename' }, 400);
  }

  const filePath = path.join(AVATARS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return c.json({ error: 'Avatar not found' }, 404);
  }

  const ext = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';
  const data = await readFile(filePath);

  return new Response(data, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
});

export default authRoutes;
