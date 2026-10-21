/**
 * SOGDIA pricing & rule-set.
 * Single source of truth — every account snapshots these values at creation,
 * so editing this file never retro-changes live accounts.
 */

export type AccountType = 'one_step' | 'instant';

export interface Plan {
  key: string;
  type: AccountType;
  label: string;
  /** Virtual capital granted to the trader. */
  size: number;
  /** What the trader pays, in USD. */
  price: number;
  /** % profit needed to pass. null = no evaluation (instant funding). */
  profit_target_pct: number | null;
  daily_dd_pct: number;
  max_dd_pct: number;
  max_leverage: number;
  payout_split_pct: number;
  payout_cycle_days: number;
}

/** Global constants. */
export const PAYOUT_SPLIT_PCT = 80;      // trader keeps 80, firm keeps 20
export const PAYOUT_CYCLE_DAYS = 14;
export const MAX_LEVERAGE = 200;
export const MIN_LEVERAGE = 1;
/** 0.05% total spread, applied against the trader on entry and exit. */
export const SPREAD_BPS = 5;

/** Drawdown rule-sets per account type. */
export const RULES: Record<AccountType, {
  profit_target_pct: number | null;
  daily_dd_pct: number;
  max_dd_pct: number;
}> = {
  one_step: { profit_target_pct: 10, daily_dd_pct: 4, max_dd_pct: 6 },
  instant:  { profit_target_pct: null, daily_dd_pct: 3, max_dd_pct: 5 },
};

const ONE_STEP_PRICING: Array<[size: number, price: number]> = [
  [5_000, 39],
  [10_000, 69],
  [25_000, 149],
  [50_000, 249],
  [100_000, 399],
];

const INSTANT_PRICING: Array<[size: number, price: number]> = [
  [5_000, 63],
  [10_000, 91],
  [25_000, 183],
  [50_000, 275],
  [100_000, 459],
];

function sizeLabel(size: number): string {
  return `$${size / 1000}K`;
}

function buildPlans(type: AccountType, rows: Array<[number, number]>): Plan[] {
  const rules = RULES[type];
  const prefix = type === 'one_step' ? 'one_step' : 'instant';
  const name = type === 'one_step' ? 'One-Step' : 'Instant Funding';

  return rows.map(([size, price]) => ({
    key: `${prefix}_${size / 1000}k`,
    type,
    label: `${name} ${sizeLabel(size)}`,
    size,
    price,
    profit_target_pct: rules.profit_target_pct,
    daily_dd_pct: rules.daily_dd_pct,
    max_dd_pct: rules.max_dd_pct,
    max_leverage: MAX_LEVERAGE,
    payout_split_pct: PAYOUT_SPLIT_PCT,
    payout_cycle_days: PAYOUT_CYCLE_DAYS,
  }));
}

export const PLANS: Plan[] = [
  ...buildPlans('one_step', ONE_STEP_PRICING),
  ...buildPlans('instant', INSTANT_PRICING),
];

export const PLANS_BY_KEY: Record<string, Plan> = Object.fromEntries(
  PLANS.map((p) => [p.key, p]),
);

export function getPlan(key: string): Plan | null {
  return PLANS_BY_KEY[key] ?? null;
}

export const PLAN_KEYS = PLANS.map((p) => p.key);
