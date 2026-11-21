/**
 * Shared avatar upload pipeline (ISSUE-11 B9).
 *
 * Three routes previously kept three structurally identical copies of this
 * flow: `routes/config.ts` (system agent avatar), `routes/auth.ts` (user and
 * AI avatars) and `routes/agent-profiles.ts` (per-profile avatar). This
 * module owns the common parts — multipart field reading, size and MIME
 * validation, the error texts, and writing the file under DATA_DIR/avatars
 * — while each route keeps only its auth checks, filename prefix and
 * stale-file reap policy.
 *
 * Registered non-goals (issue scope): MIME case normalization stays as-is
 * (exact-match on the client-provided content type), and the reap strategy
 * itself is route policy, expressed through the parameterized
 * reapAvatarFiles helper below.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { DATA_DIR } from './config.js';
import { AVATAR_MAX_FILE_BYTES } from './http-upload-policy.js';

/** Directory all avatar files live in; served by GET /api/auth/avatars/:filename. */
export const AVATARS_DIR = path.join(DATA_DIR, 'avatars');

/** Upload-direction MIME → filename extension map (exact-match, no case folding). */
const AVATAR_MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/**
 * Structural request surface consumed by storeAvatarUpload. Hono contexts
 * satisfy it, keeping this module free of hono generic typing.
 */
interface AvatarUploadRequest {
  header(name: string): string | undefined;
  formData(): Promise<FormData>;
}

type AvatarUploadOutcome =
  | { ok: true; filename: string; avatarUrl: string }
  | { ok: false; status: 400 | 413; error: string };

/**
 * Validate and persist one multipart avatar upload. `filenamePrefix` is the
 * route's naming policy (e.g. `system-agent-`, `${userId}-ai-`,
 * `agent-profile-${id}-`); the stored filename appends a random hex token and
 * the MIME's extension. Returns the canonical public URL
 * `/api/auth/avatars/{filename}` on success, or the error status + text the
 * three routes historically emitted.
 */
export async function storeAvatarUpload(
  request: AvatarUploadRequest,
  filenamePrefix: string,
): Promise<AvatarUploadOutcome> {
  if (!(request.header('content-type') || '').includes('multipart/form-data')) {
    return { ok: false, status: 400, error: 'Expected multipart/form-data' };
  }
  const formData = await request.formData();
  const file = formData.get('avatar');
  if (!file || !(file instanceof File)) {
    return { ok: false, status: 400, error: 'No avatar file provided' };
  }
  if (file.size > AVATAR_MAX_FILE_BYTES) {
    return { ok: false, status: 413, error: 'File too large (max 3MB)' };
  }
  const extension = AVATAR_MIME_EXTENSIONS[file.type];
  if (!extension) {
    return {
      ok: false,
      status: 400,
      error: 'Unsupported image type. Use jpg, png, gif or webp',
    };
  }

  fs.mkdirSync(AVATARS_DIR, { recursive: true });
  const filename = `${filenamePrefix}${randomBytes(4).toString('hex')}${extension}`;
  const destination = path.join(AVATARS_DIR, filename);
  const temporary = `${destination}.tmp`;
  fs.writeFileSync(temporary, Buffer.from(await file.arrayBuffer()));
  fs.renameSync(temporary, destination);
  return { ok: true, filename, avatarUrl: `/api/auth/avatars/${filename}` };
}

interface AvatarReapOptions {
  /** Only files whose names start with this prefix are considered stale. */
  prefix: string;
  /** Basenames never to delete (the just-written file, another field's file). */
  keep?: Iterable<string>;
  /**
   * Basename prefixes of the other avatar fields' files. Skipped
   * structurally (not just via `keep`): a concurrent upload of the other
   * field may have already written its file while its DB url is not yet
   * visible to the caller, so a prefix skip is what prevents reaping that
   * concurrent upload out from under its own dangling url.
   */
  skipPrefixes?: string[];
}

/** Delete stale avatar files according to the route's reap policy. */
export function reapAvatarFiles(options: AvatarReapOptions): void {
  if (!fs.existsSync(AVATARS_DIR)) return;
  const keep = new Set(options.keep ?? []);
  for (const filename of fs.readdirSync(AVATARS_DIR)) {
    if (!filename.startsWith(options.prefix) || keep.has(filename)) continue;
    if (options.skipPrefixes?.some((skip) => filename.startsWith(skip))) {
      continue;
    }
    fs.rmSync(path.join(AVATARS_DIR, filename), { force: true });
  }
}
