import { ApiError, requireEnv } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase';
import { isStaffRole, normalizeRole } from '@/lib/roles';
import type { DbAccount, DbUser } from '@/lib/types';

function bearer(req: Request): string {
  const header = req.headers.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw new ApiError('UNAUTHORIZED', 'Missing bearer token.');
  }
  return token;
}

/**
 * Resolve the caller from their Supabase JWT.
 *
 * Reads the profile with the SERVICE-ROLE client, so RLS never applies
 * to this lookup. If this throws "User profile not found", the likely
 * cause is SUPABASE_SERVICE_ROLE_KEY actually holding the anon key —
 * under RLS with no auth context the select returns zero rows.
 */
export async function requireUser(req: Request): Promise<DbUser> {
  const token = bearer(req);

  // A verified session is reused for a few seconds: the terminal fires a request every 2-4 s and each
  // verification is two sequential Supabase round trips. Role / profile edits show up within the TTL.
  const hit = userCache.get(token);
  if (hit && Date.now() - hit.at < USER_TTL_MS) return hit.user;

  const user = await resolveUser(token);
  userCache.set(token, { user, at: Date.now() });
  if (userCache.size > 5_000) {
    const now = Date.now();
    for (const [k, v] of userCache) if (now - v.at >= USER_TTL_MS) userCache.delete(k);
  }
  return user;
}

const USER_TTL_MS = 30_000;
const userCache = new Map<string, { user: DbUser; at: number }>();

async function resolveUser(token: string): Promise<DbUser> {
  const admin = supabaseAdmin();

  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData?.user) {
    throw new ApiError('UNAUTHORIZED', 'Invalid or expired session.');
  }

  const authUserId = authData.user.id;

  // maybeSingle, so a genuine DB/permission failure is distinguishable
  // from "the row isn't there" instead of collapsing into one message.
  const { data: profile, error } = await admin
    .from('users')
    .select('*')
    .eq('id', authUserId)
    .maybeSingle<DbUser>();

  if (error) {
    console.error('[auth] profile lookup failed', { authUserId, error: error.message });
    throw new ApiError(
      'INTERNAL_ERROR',
      'Could not read the user profile.',
      { auth_user_id: authUserId, db_error: error.message },
    );
  }

  if (!profile) {
    throw new ApiError(
      'UNAUTHORIZED',
      'User profile not found. The auth user exists but has no row in public.users.',
      { auth_user_id: authUserId },
    );
  }

  // Normalise once, here, so every downstream guard compares a clean value.
  const role = normalizeRole(profile.role);
  if (role === null) {
    console.error('[auth] unrecognised role in public.users', {
      user_id: profile.id,
      email: profile.email,
      raw_role: JSON.stringify(profile.role),
    });
    throw new ApiError(
      'FORBIDDEN',
      'Your account has an unrecognised role. Contact an administrator.',
      { user_id: profile.id, raw_role: String(profile.role) },
    );
  }

  return { ...profile, role };
}

/**
 * Staff guard: admin or xdepartment.
 * Kept as an alias of the same predicate `requireStaff` uses, so the two
 * entry points can never drift apart.
 */
export async function requireAdmin(req: Request): Promise<DbUser> {
  const user = await requireUser(req);

  if (!isStaffRole(user.role)) {
    throw new ApiError(
      'FORBIDDEN',
      'Admin privileges required.',
      { user_id: user.id, role: user.role, required: 'admin or xdepartment' },
    );
  }
  return user;
}

/** Load an account and assert the caller may see it (staff bypass). */
export async function requireAccount(
  accountId: string,
  user: DbUser,
): Promise<DbAccount> {
  const { data, error } = await supabaseAdmin()
    .from('accounts')
    .select('*')
    .eq('id', accountId)
    .maybeSingle<DbAccount>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  // Name the id that was asked for: a stale account id sent by a client
  // must not be mistakable for a problem with the account it displays.
  if (!data) {
    throw new ApiError('NOT_FOUND', `Account ${accountId} does not exist.`, {
      requested_account_id: accountId,
    });
  }

  if (data.user_id !== user.id && !isStaffRole(user.role)) {
    throw new ApiError('FORBIDDEN', `Account ${accountId} belongs to another user.`, {
      requested_account_id: accountId,
    });
  }
  return data;
}

/** Guard machine-to-machine cron routes. */
export function requireCronSecret(req: Request): void {
  const provided = req.headers.get('x-cron-secret');
  const expected = requireEnv('CRON_SECRET');
  if (!provided || provided !== expected) {
    throw new ApiError('UNAUTHORIZED', 'Invalid cron secret.');
  }
}
