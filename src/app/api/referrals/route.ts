import { ApiError, handle, ok } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { ensureReferralCode } from '@/lib/referrals';
import { getSettings } from '@/lib/settings';
import { money } from '@/lib/math';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** GET /api/referrals — the caller's affiliate code, signups and commissions. */
export const GET = handle(async (req) => {
  const user = await requireUser(req);
  const code = await ensureReferralCode(user);
  const { settings } = await getSettings();
  const admin = supabaseAdmin();

  const [{ count: signups }, { data: commissions, error }] = await Promise.all([
    admin.from('users').select('id', { count: 'exact', head: true }).eq('referred_by', user.id),
    admin
      .from('transactions')
      .select('amount, status, created_at')
      .eq('user_id', user.id)
      .eq('type', 'commission')
      .order('created_at', { ascending: false }),
  ]);

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  const rows = (commissions ?? []) as Array<{ amount: number; status: string; created_at: string }>;
  const total = money(rows.reduce((s, r) => s + Number(r.amount), 0));
  const paid = money(
    rows.filter((r) => r.status === 'paid').reduce((s, r) => s + Number(r.amount), 0),
  );

  return ok({
    referral_code: code,
    commission_pct: settings.referral_commission_pct,
    friend_discount_pct: settings.referral_discount_pct,
    signups: signups ?? 0,
    earned_total: total,
    earned_paid: paid,
    earned_pending: money(total - paid),
    history: rows,
  });
});
