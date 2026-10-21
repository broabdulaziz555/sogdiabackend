import { ApiError, handle, ok } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase';
import { pct } from '@/lib/math';
import type { AccountType } from '@/config/pricing';

export const revalidate = 60;

interface Row {
  id: string;
  size: number;
  balance: number;
  type: AccountType;
  status: string;
  created_at: string;
  users: { full_name: string | null; country: string | null } | null;
}

function anonymize(name: string | null, index: number): string {
  if (!name) return `Trader #${index + 1}`;
  const [first, ...rest] = name.trim().split(/\s+/);
  const initial = rest.length ? `${rest[rest.length - 1][0]}.` : '';
  return `${first} ${initial}`.trim();
}

/**
 * GET /api/leaderboard?type=one_step&limit=25
 * Public ranking by realised return on the account. Names are shortened
 * to "First L." — no emails, no account ids.
 */
export const GET = handle(async (req) => {
  const url = new URL(req.url);
  const type = url.searchParams.get('type') as AccountType | null;
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 25) || 25, 100);

  let query = supabaseAdmin()
    .from('accounts')
    .select('id, size, balance, type, status, created_at, users(full_name, country)')
    .in('status', ['active', 'passed'])
    .limit(500);

  if (type) query = query.eq('type', type);

  const { data, error } = await query;
  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  const ranked = ((data ?? []) as unknown as Row[])
    .map((row) => ({
      size: Number(row.size),
      return_pct: pct(((Number(row.balance) - Number(row.size)) / Number(row.size)) * 100),
      type: row.type,
      status: row.status,
      country: row.users?.country ?? null,
      name: row.users?.full_name ?? null,
      since: row.created_at,
    }))
    .filter((r) => r.return_pct > 0)
    .sort((a, b) => b.return_pct - a.return_pct)
    .slice(0, limit)
    .map((r, i) => ({
      rank: i + 1,
      trader: anonymize(r.name, i),
      country: r.country,
      account_size: r.size,
      type: r.type,
      return_pct: r.return_pct,
      status: r.status,
      since: r.since,
    }));

  return ok({ leaderboard: ranked, updated_at: new Date().toISOString() });
});
