import { handle, ok } from '@/lib/http';
import { requireStaff } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { money } from '@/lib/math';
import type { AccountStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** GET /api/admin/stats — operations dashboard. */
export const GET = handle(async (req) => {
  await requireStaff(req);
  const admin = supabaseAdmin();

  const statuses: AccountStatus[] = ['active', 'passed', 'failed', 'frozen', 'breached', 'closed'];

  const [
    usersRes,
    accountRes,
    revenueRes,
    paidRes,
    pendingPayoutRes,
    kycRes,
    openRes,
  ] = await Promise.all([
    admin.from('users').select('id', { count: 'exact', head: true }),
    admin.from('accounts').select('status'),
    admin.from('transactions').select('amount').eq('type', 'purchase').eq('status', 'paid'),
    admin.from('transactions').select('net_amount').eq('type', 'payout').eq('status', 'paid'),
    admin
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('type', 'payout')
      .eq('status', 'pending'),
    admin.from('users').select('id', { count: 'exact', head: true }).eq('kyc_status', 'pending'),
    admin.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'open'),
  ]);

  const accounts = Object.fromEntries(statuses.map((s) => [s, 0])) as Record<AccountStatus, number>;
  for (const row of (accountRes.data ?? []) as Array<{ status: AccountStatus }>) {
    accounts[row.status] = (accounts[row.status] ?? 0) + 1;
  }

  const revenue = money(
    ((revenueRes.data ?? []) as Array<{ amount: number }>).reduce((s, r) => s + Number(r.amount), 0),
  );
  const payoutsPaid = money(
    ((paidRes.data ?? []) as Array<{ net_amount: number | null }>).reduce(
      (s, r) => s + Number(r.net_amount ?? 0),
      0,
    ),
  );

  return ok({
    users: usersRes.count ?? 0,
    accounts,
    revenue_usd: revenue,
    payouts_paid_usd: payoutsPaid,
    payouts_pending: pendingPayoutRes.count ?? 0,
    kyc_pending: kycRes.count ?? 0,
    open_positions: openRes.count ?? 0,
  });
});
