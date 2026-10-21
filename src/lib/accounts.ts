import { ApiError } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase';
import {
  getPlan,
  MAX_LEVERAGE,
  PAYOUT_CYCLE_DAYS,
  PAYOUT_SPLIT_PCT,
  RULES,
  type Plan,
} from '@/config/pricing';
import type { DbAccount } from '@/lib/types';

/**
 * Creates a funded/evaluation account from a plan snapshot.
 * Called only by the NOWPayments webhook once a payment is confirmed
 * (and by admin tooling).
 */
export async function createAccountFromPlan(
  userId: string,
  plan: Plan,
): Promise<DbAccount> {
  const now = new Date();
  const nextPayout = new Date(now.getTime() + plan.payout_cycle_days * 86_400_000);

  const { data, error } = await supabaseAdmin()
    .from('accounts')
    .insert({
      user_id: userId,
      type: plan.type,
      size: plan.size,
      balance: plan.size,
      equity: plan.size,
      daily_start_balance: plan.size,
      status: 'active',
      max_leverage: plan.max_leverage,
      profit_target_pct: plan.profit_target_pct,
      daily_dd_pct: plan.daily_dd_pct,
      max_dd_pct: plan.max_dd_pct,
      payout_split_pct: plan.payout_split_pct,
      payout_cycle_days: plan.payout_cycle_days,
      plan_key: plan.key,
      next_payout_at: nextPayout.toISOString(),
    })
    .select('*')
    .single<DbAccount>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  return data;
}

export interface ProvisionOptions {
  type: 'one_step' | 'instant';
  size: number;
  plan_key?: string | null;
  is_gifted?: boolean;
  rules?: Partial<{
    profit_target_pct: number | null;
    daily_dd_pct: number;
    max_dd_pct: number;
    max_leverage: number;
    payout_split_pct: number;
    payout_cycle_days: number;
    min_trading_days: number;
    consistency_pct: number | null;
  }>;
}

/**
 * X-Department provisioning: any type, any size, any rule-set.
 * Falls back to the standard rules for the chosen type when no override
 * is supplied, so a gifted account behaves exactly like a bought one.
 */
export async function provisionAccount(
  userId: string,
  options: ProvisionOptions,
): Promise<DbAccount> {
  const defaults = RULES[options.type];
  const rules = options.rules ?? {};
  const cycleDays = rules.payout_cycle_days ?? PAYOUT_CYCLE_DAYS;
  const nextPayout = new Date(Date.now() + cycleDays * 86_400_000);

  const { data, error } = await supabaseAdmin()
    .from('accounts')
    .insert({
      user_id: userId,
      type: options.type,
      size: options.size,
      balance: options.size,
      equity: options.size,
      daily_start_balance: options.size,
      status: 'active',
      max_leverage: rules.max_leverage ?? MAX_LEVERAGE,
      profit_target_pct:
        rules.profit_target_pct !== undefined
          ? rules.profit_target_pct
          : defaults.profit_target_pct,
      daily_dd_pct: rules.daily_dd_pct ?? defaults.daily_dd_pct,
      max_dd_pct: rules.max_dd_pct ?? defaults.max_dd_pct,
      payout_split_pct: rules.payout_split_pct ?? PAYOUT_SPLIT_PCT,
      payout_cycle_days: cycleDays,
      min_trading_days: rules.min_trading_days ?? 0,
      consistency_pct: rules.consistency_pct ?? null,
      plan_key: options.plan_key ?? null,
      is_gifted: options.is_gifted ?? false,
      next_payout_at: nextPayout.toISOString(),
    })
    .select('*')
    .single<DbAccount>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  return data;
}

export function planForAccount(account: DbAccount): Plan | null {
  return account.plan_key ? getPlan(account.plan_key) : null;
}

/** Numeric columns come back as strings from PostgREST on some setups. */
export function serializeAccount(a: DbAccount) {
  return {
    ...a,
    size: Number(a.size),
    balance: Number(a.balance),
    equity: Number(a.equity),
    daily_start_balance: Number(a.daily_start_balance),
    profit_target_pct: a.profit_target_pct === null ? null : Number(a.profit_target_pct),
    daily_dd_pct: Number(a.daily_dd_pct),
    max_dd_pct: Number(a.max_dd_pct),
    payout_split_pct: Number(a.payout_split_pct),
  };
}
