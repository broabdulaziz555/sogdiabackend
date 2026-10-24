import { ApiError, handle, ok } from '@/lib/http';
import { requireStaff } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { paginationSchema } from '@/lib/validation';
import type { DbUser, KycStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** GET /api/admin/users?query=&kyc_status=&role=&limit=&offset= */
export const GET = handle(async (req) => {
  await requireStaff(req);
  const url = new URL(req.url);
  const { limit, offset } = paginationSchema.parse({
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  });

  const search = url.searchParams.get('query');
  const kycStatus = url.searchParams.get('kyc_status') as KycStatus | null;
  const role = url.searchParams.get('role');

  let query = supabaseAdmin()
    .from('users')
    .select('*, accounts(count)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (search) query = query.or(`email.ilike.%${search}%,full_name.ilike.%${search}%`);
  if (kycStatus) query = query.eq('kyc_status', kycStatus);
  if (role) query = query.eq('role', role);

  const { data, error, count } = await query;
  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  const rows = (data ?? []) as Array<DbUser & { accounts: Array<{ count: number }> }>;

  return ok({
    users: rows.map(({ accounts, ...u }) => ({
      ...u,
      accounts_count: accounts?.[0]?.count ?? 0,
    })),
    total: count ?? rows.length,
    limit,
    offset,
  });
});
