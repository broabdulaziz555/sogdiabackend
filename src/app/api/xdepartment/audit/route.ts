import { ApiError, handle, ok } from '@/lib/http';
import { requireXDepartment } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { paginationSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/** GET /api/xdepartment/audit?actor_id=&action=&target_id=&limit=&offset= */
export const GET = handle(async (req) => {
  await requireXDepartment(req);
  const url = new URL(req.url);
  const { limit, offset } = paginationSchema.parse({
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  });

  let query = supabaseAdmin()
    .from('audit_logs')
    .select('*, users!audit_logs_actor_id_fkey(email)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  const actorId = url.searchParams.get('actor_id');
  const action = url.searchParams.get('action');
  const targetId = url.searchParams.get('target_id');
  if (actorId) query = query.eq('actor_id', actorId);
  if (action) query = query.eq('action', action);
  if (targetId) query = query.eq('target_id', targetId);

  const { data, error, count } = await query;
  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  const rows = (data ?? []) as Array<Record<string, unknown> & { users: { email: string } | null }>;

  return ok({
    logs: rows.map(({ users, ...row }) => ({ ...row, actor_email: users?.email ?? null })),
    total: count ?? rows.length,
    limit,
    offset,
  });
});
