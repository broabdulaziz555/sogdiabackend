/**
 * Canonical legal strings.
 *
 * Import these rather than hardcoding disclosure text in components — the
 * footer appears on every page and must not drift between them.
 *
 * The prose source of truth is legal/footer.md, legal/execution.md and
 * legal/terms.md. Keep this file in sync with them.
 */

/** Site-wide footer. Rendered at the foot of every page. */
export const TRADING_FOOTER =
  'Trading and execution. SOGDIA operates a proprietary trading and ' +
  'risk-management framework. Evaluation accounts are governed by the rules ' +
  'in effect at the time of purchase. Traders who meet the stated objectives ' +
  'will be offered a funded arrangement, subject to verification and the ' +
  'applicable funding terms. SOGDIA maintains capital and execution partner ' +
  'relationships. The execution model, spreads and fees applicable to each ' +
  'account are set out in the Execution Disclosure and the applicable ' +
  'account terms. Market data may be delayed, interrupted or inaccurate.';

/**
 * The footer defers the execution model to this page, so the link must
 * resolve. If it 404s, the footer misleads by omission.
 */
export const EXECUTION_DISCLOSURE_PATH = '/legal/execution';
export const TERMS_PATH = '/legal/terms';

/** Short form, for tight spaces (order tickets, confirmation modals). */
export const EXECUTION_SHORT =
  'Orders are executed against SOGDIA\'s execution engine using third-party ' +
  'reference prices, with a 0.05% spread applied on entry and exit. See the ' +
  'Execution Disclosure.';

/** Figures quoted in the disclosures. Keep aligned with config/pricing.ts. */
export const DISCLOSED_TERMS = {
  spread_pct: 0.05,
  payout_split_pct: 80,
  payout_cycle_days: 14,
} as const;
