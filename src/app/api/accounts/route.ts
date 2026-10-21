import { ApiError, handle, ok } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { serializeAccount } from '@/lib/accounts';
import type { AccountStatus, DbAccount } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** GET /api/accounts?status=active */
export const GET = handle(async (req) => {
  const user = await requireUser(req);
  const status = new URL(req.url).searchParams.get('status') as AccountStatus | null;

  let query = supabaseAdmin()
    .from('accounts')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  return ok({ accounts: ((data ?? []) as DbAccount[]).map(serializeAccount) });
});
