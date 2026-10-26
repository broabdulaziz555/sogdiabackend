import { ApiError, handle, ok } from '@/lib/http';
import { requireStaff } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { serializeAccount } from '@/lib/accounts';
import { paginationSchema } from '@/lib/validation';
import type { AccountStatus, DbAccount } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** A hex prefix of an account id ("a2092f", "a2092f12-34") as an inclusive uuid range, or null if it isn't one. */
function idPrefixRange(q: string): [string, string] | null {
  const hex = q.toLowerCase().replace(/^#/, '').replace(/-/g, '');
  if (!/^[0-9a-f]{4,32}$/.test(hex)) return null;
  const fmt = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  return [fmt(hex.padEnd(32, '0')), fmt(hex.padEnd(32, 'f'))];
}

/** GET /api/admin/accounts?status=&user_id=&query=&limit=&offset= — query matches an account id (or its prefix), or the owner's email / name. */
export const GET = handle(async (req) => {
  await requireStaff(req);
  const url = new URL(req.url);
  const { limit, offset } = paginationSchema.parse({
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  });

  const status = url.searchParams.get('status') as AccountStatus | null;
  const userId = url.searchParams.get('user_id');
  const search = (url.searchParams.get('query') ?? '').trim();
  const idRange = search ? idPrefixRange(search) : null;
  const byOwner = !!search && !idRange;

  let query = supabaseAdmin()
    .from('accounts')
    .select(byOwner ? '*, users!inner(email, full_name)' : '*, users(email, full_name)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('status', status);
  if (userId) query = query.eq('user_id', userId);
  if (idRange) query = query.gte('id', idRange[0]).lte('id', idRange[1]);
  if (byOwner) {
    const like = `%${search.replace(/[%_,()]/g, ' ')}%`;
    query = query.or(`email.ilike.${like},full_name.ilike.${like}`, { referencedTable: 'users' });
  }

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
