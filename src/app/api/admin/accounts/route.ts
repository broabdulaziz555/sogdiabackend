import { ApiError, handle, ok } from '@/lib/http';
import { requireStaff } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { serializeAccount } from '@/lib/accounts';
import { paginationSchema } from '@/lib/validation';
import type { AccountStatus, DbAccount } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** GET /api/admin/accounts?status=&user_id=&limit=&offset= */
export const GET = handle(async (req) => {
  await requireStaff(req);
  const url = new URL(req.url);
  const { limit, offset } = paginationSchema.parse({
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  });

  const status = url.searchParams.get('status') as AccountStatus | null;
  const userId = url.searchParams.get('user_id');

  let query = supabaseAdmin()
    .from('accounts')
    .select('*, users(email, full_name)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('status', status);
  if (userId) query = query.eq('user_id', userId);

  const { data, error, count } = await query;
  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  const rows = (data ?? []) as Array<DbAccount & { users: { email: string; full_name: string | null } | null }>;

  return ok({
    accounts: rows.map(({ users, ...a }) => ({
      ...serializeAccount(a),
      user_email: users?.email ?? null,
      user_name: users?.full_name ?? null,
    })),
    total: count ?? rows.length,
    limit,
    offset,
  });
});
