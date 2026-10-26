import type { AccountType } from '@/config/pricing';

export type UserRole = 'trader' | 'admin' | 'xdepartment';
export type KycStatus = 'not_submitted' | 'pending' | 'verified' | 'rejected';
export type AccountStatus = 'active' | 'passed' | 'failed' | 'frozen' | 'breached' | 'closed';
export type OrderSide = 'long' | 'short';
export type OrderStatus = 'open' | 'closed' | 'liquidated';
export type TransactionType = 'purchase' | 'payout' | 'refund' | 'adjustment' | 'commission';
export type TransactionStatus = 'pending' | 'approved' | 'paid' | 'rejected' | 'failed';
export type CertificateType = 'eval_pass' | 'payout' | 'phase1_pass' | 'phase2_pass' | 'funded' | 'achievement' | 'custom';

export interface DbUser {
  id: string;
  email: string;
  role: UserRole;
  kyc_status: KycStatus;
  kyc_document_url: string | null;
  kyc_note: string | null;
  wallet_address: string | null;
  full_name: string | null;
  country: string | null;
  referral_code: string | null;
  referred_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbAccount {
  id: string;
  user_id: string;
  type: AccountType;
  size: number;
  balance: number;
  equity: number;
  daily_start_balance: number;
  status: AccountStatus;
  max_leverage: number;
  profit_target_pct: number | null;
  daily_dd_pct: number;
  max_dd_pct: number;
  payout_split_pct: number;
  payout_cycle_days: number;
  plan_key: string | null;
  /** Optional add-on rules. 0 / null = disabled, which is the default. */
  min_trading_days: number;
  consistency_pct: number | null;
  is_gifted: boolean;
  breach_reason: string | null;
  last_payout_at: string | null;
  next_payout_at: string | null;
  daily_reset_at: string;
  created_at: string;
  updated_at: string;
}

export interface DbOrder {
  id: string;
  account_id: string;
  user_id: string;
  symbol: string;
  side: OrderSide;
  leverage: number;
  margin: number;
  position_size: number;
  quantity: number;
  entry_price: number;
  mark_price_at_open: number;
  liquidation_price: number;
  take_profit: number | null;
  stop_loss: number | null;
  parent_order_id: string | null;
  close_price: number | null;
  pnl: number | null;
  status: OrderStatus;
  close_reason: string | null;
  created_at: string;
  closed_at: string | null;
}

export interface DbTransaction {
  id: string;
  user_id: string;
  account_id: string | null;
  amount: number;
  net_amount: number | null;
  currency: string;
  type: TransactionType;
  status: TransactionStatus;
  wallet_address: string | null;
  tx_hash: string | null;
  nowpayments_payment_id: string | null;
  nowpayments_order_id: string | null;
  admin_note: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DbCertificate {
  id: string;
  user_id: string;
  account_id: string | null;
  type: CertificateType;
  amount: number;
  code: string;
  display_name: string | null;
  is_manual: boolean;
  issued_by: string | null;
  metadata: Record<string, unknown>;
  issued_at: string;
}

export interface Position extends DbOrder {
  mark_price: number;
  unrealized_pnl: number;
  unrealized_pnl_pct: number;
  /**
   * 'fallback' when no live Binance price could be had and the open price stands in for it. Such a position is still
   * listed, but the risk sweep never closes anything on a stand-in price.
   */
  price_source?: 'live' | 'fallback';
}

export interface AccountMetrics {
  equity: number;
  unrealized_pnl: number;
  used_margin: number;
  free_margin: number;
  open_positions: number;
  daily_dd_limit: number;
  max_dd_limit: number;
  daily_dd_remaining: number;
  max_dd_remaining: number;
  daily_dd_used_pct: number;
  max_dd_used_pct: number;
  profit_target: number | null;
  profit_pct: number;
  target_reached: boolean;
}

export type BreachReason = 'DAILY_DRAWDOWN' | 'MAX_DRAWDOWN' | null;

export interface RiskResult {
  breached: boolean;
  reason: BreachReason;
  status: AccountStatus;
  closed_orders: number;
  passed?: boolean;
}
