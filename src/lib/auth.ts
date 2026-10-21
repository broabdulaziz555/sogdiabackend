import { ApiError, requireEnv } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase';
import type { DbAccount, DbUser } from '@/lib/types';

function bearer(req: Request): string {
  const header = req.headers.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw new ApiError('UNAUTHORIZED', 'Missing bearer token.');
  }
  return token;
}

/** Resolve the caller from their Supabase JWT. */
export async function requireUser(req: Request): Promise<DbUser> {
  const token = bearer(req);
  const admin = supabaseAdmin();

  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData?.user) {
    throw new ApiError('UNAUTHORIZED', 'Invalid or expired session.');
  }

  const { data: profile, error } = await admin
    .from('users')
    .select('*')
    .eq('id', authData.user.id)
    .single<DbUser>();

  if (error || !profile) {
    throw new ApiError('UNAUTHORIZED', 'User profile not found.');
  }
  return profile;
}

/** admin or xdepartment. See lib/permissions.ts for the full ladder. */
export async function requireAdmin(req: Request): Promise<DbUser> {
  const user = await requireUser(req);
  if (user.role !== 'admin' && user.role !== 'xdepartment') {
    throw new ApiError('FORBIDDEN', 'Admin privileges required.');
  }
  return user;
}

/** Load an account and assert the caller owns it (admins bypass). */
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
  if (!data) throw new ApiError('NOT_FOUND', 'Account not found.');
  if (data.user_id !== user.id && user.role === 'trader') {
    throw new ApiError('FORBIDDEN', 'This account belongs to another user.');
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
