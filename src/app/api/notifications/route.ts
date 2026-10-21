import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { paginationSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/** GET /api/notifications?unread=true&limit=&offset= */
export const GET = handle(async (req) => {
  const user = await requireUser(req);
  const url = new URL(req.url);
  const { limit, offset } = paginationSchema.parse({
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  });

  let query = supabaseAdmin()
    .from('notifications')
    .select('*', { count: 'exact' })
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (url.searchParams.get('unread') === 'true') query = query.is('read_at', null);

  const { data, error, count } = await query;
  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  const { count: unread } = await supabaseAdmin()
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .is('read_at', null);

  return ok({ notifications: data ?? [], unread: unread ?? 0, total: count ?? 0, limit, offset });
});

/** POST /api/notifications — mark read. Body: { ids?: uuid[], all?: boolean } */
export const POST = handle(async (req) => {
  const user = await requireUser(req);
  const body = (await readJson(req)) as { ids?: string[]; all?: boolean };

  let query = supabaseAdmin()
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('user_id', user.id)
    .is('read_at', null);

  if (!body.all) {
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      throw new ApiError('VALIDATION_ERROR', 'Provide ids[] or all:true.');
    }
    query = query.in('id', body.ids);
  }

  const { error } = await query;
  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  return ok({ marked_read: true });
});
