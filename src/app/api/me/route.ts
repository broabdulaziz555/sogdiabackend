import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { updateMeSchema } from '@/lib/validation';
import type { DbUser } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function publicUser(u: DbUser) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    kyc_status: u.kyc_status,
    wallet_address: u.wallet_address,
    full_name: u.full_name,
    country: u.country,
    created_at: u.created_at,
  };
}

/** GET /api/me */
export const GET = handle(async (req) => {
  const user = await requireUser(req);

  const admin = supabaseAdmin();
  const [{ count: total }, { count: active }] = await Promise.all([
    admin.from('accounts').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
    admin
      .from('accounts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('status', 'active'),
  ]);

  return ok({
    user: publicUser(user),
    accounts_count: total ?? 0,
    active_accounts: active ?? 0,
  });
});

/** PATCH /api/me */
export const PATCH = handle(async (req) => {
  const user = await requireUser(req);
  const body = updateMeSchema.parse(await readJson(req));

  const { data, error } = await supabaseAdmin()
    .from('users')
    .update(body)
    .eq('id', user.id)
    .select('*')
    .single<DbUser>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  return ok({ user: publicUser(data) });
});
