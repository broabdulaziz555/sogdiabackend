import { ApiError, handle, ok } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { certificateImageUrl } from '@/lib/certificates';
import type { DbCertificate } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** GET /api/certificates?account_id=uuid */
export const GET = handle(async (req) => {
  const user = await requireUser(req);
  const accountId = new URL(req.url).searchParams.get('account_id');

  let query = supabaseAdmin()
    .from('certificates')
    .select('*')
    .eq('user_id', user.id)
    .order('issued_at', { ascending: false });

  if (accountId) query = query.eq('account_id', accountId);

  const { data, error } = await query;
  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  return ok({
    certificates: ((data ?? []) as DbCertificate[]).map((c) => ({
      ...c,
      amount: Number(c.amount),
      image_url: certificateImageUrl(c.id),
    })),
  });
});
