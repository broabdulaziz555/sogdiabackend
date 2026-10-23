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
  return resolveUser(bearer(req));
}

/**
 * Only the token -> auth user id step is remembered (for a few seconds). The profile row is always read fresh, so
 * a role change, KYC approval or wallet update is visible on the very next request.
 */
const TOKEN_TTL_MS = 30_000;
const verifiedTokens = new Map<string, { id: string; at: number }>();

async function authUserId(token: string): Promise<string> {
  const hit = verifiedTokens.get(token);
  if (hit && Date.now() - hit.at < TOKEN_TTL_MS) return hit.id;

  const { data, error } = await supabaseAdmin().auth.getUser(token);
  if (error || !data?.user) {
    throw new ApiError('UNAUTHORIZED', 'Invalid or expired session.');
  }

  verifiedTokens.set(token, { id: data.user.id, at: Date.now() });
  if (verifiedTokens.size > 5_000) {
    const now = Date.now();
    for (const [k, v] of verifiedTokens) if (now - v.at >= TOKEN_TTL_MS) verifiedTokens.delete(k);
  }
  return data.user.id;
}

/** The `sub` (user id) a JWT claims. NOT verified: it only chooses which profile row to read while the token is being verified. */
function claimedUserId(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub?: unknown };
    return typeof payload.sub === 'string' && /^[0-9a-f-]{36}$/i.test(payload.sub) ? payload.sub : null;
  } catch {
    return null;
  }
}

async function readProfile(userId: string) {
  return supabaseAdmin().from('users').select('*').eq('id', userId).maybeSingle<DbUser>();
}

async function resolveUser(token: string): Promise<DbUser> {
  // Verifying the token and reading the profile are independent round trips to a far-away database, so they run
  // together. The row read for the *claimed* user is only used if the verified user turns out to be the same one.
  const claimed = claimedUserId(token);
  const [userId, early] = await Promise.all([
    authUserId(token),
    claimed ? readProfile(claimed).catch(() => null) : Promise.resolve(null),
  ]);

  // maybeSingle, so a genuine DB/permission failure is distinguishable
  // from "the row isn't there" instead of collapsing into one message.
  const { data: profile, error } = early && userId === claimed ? early : await readProfile(userId);

  if (error) {
    console.error('[auth] profile lookup failed', { userId, error: error.message });
    throw new ApiError(
      'INTERNAL_ERROR',
      'Could not read the user profile.',
      { auth_user_id: userId, db_error: error.message },
    );
  }

  if (!profile) {
    throw new ApiError(
      'UNAUTHORIZED',
      'User profile not found. The auth user exists but has no row in public.users.',
      { auth_user_id: userId },
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

  assertAccountAccess(data, user);
  return data;
}

/** The ownership rule on its own, for callers that read the account in parallel with resolving the user. */
export function assertAccountAccess(account: DbAccount, user: Pick<DbUser, 'id' | 'role'>): void {
  if (account.user_id !== user.id && !isStaffRole(user.role)) {
    throw new ApiError('FORBIDDEN', `Account ${account.id} belongs to another user.`, {
      requested_account_id: account.id,
    });
  }
}

/** Guard machine-to-machine cron routes. */
export function requireCronSecret(req: Request): void {
  const provided = req.headers.get('x-cron-secret');
  const expected = requireEnv('CRON_SECRET');
  if (!provided || provided !== expected) {
    throw new ApiError('UNAUTHORIZED', 'Invalid cron secret.');
  }
}
