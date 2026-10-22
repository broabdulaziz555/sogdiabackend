import { ApiError, handle, ok } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * GET /api/checkout/status?order=SOGDIA-xxxxxxxx
 * Lets the post-payment page show when the account is ready. Owner only.
 */
export const GET = handle(async (req) => {
  const user = await requireUser(req);
  const order = new URL(req.url).searchParams.get('order');
  if (!order) throw new ApiError('VALIDATION_ERROR', 'order is required.');

  const { data, error } = await supabaseAdmin()
    .from('transactions')
    .select('status, account_id')
    .eq('nowpayments_order_id', order)
    .eq('user_id', user.id)
    .eq('type', 'purchase')
    .maybeSingle<{ status: string; account_id: string | null }>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  if (!data) throw new ApiError('NOT_FOUND', 'Unknown order.');

  return ok({ order_id: order, status: data.status, account_id: data.account_id });
});
