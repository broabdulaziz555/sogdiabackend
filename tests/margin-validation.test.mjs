/**
 * Margin validation regression tests.
 *
 * Pure-logic mirror of src/lib/risk.ts computeMetrics + src/lib/math.ts
 * usedMargin + the guard in src/app/api/trade/open/route.ts, so the rules
 * can be exercised without a database or a network.
 *
 *   node tests/margin-validation.test.mjs
 */

const money = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

class ApiError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// --- src/lib/math.ts -------------------------------------------------
function usedMargin(orders) {
  let total = 0;
  for (const order of orders) {
    const value = order.margin;
    if (value === null || value === undefined || value === '') {
      throw new Error(`Order ${order.id ?? '(unknown)'} has no margin value.`);
    }
    const margin = Number(value);
    if (!Number.isFinite(margin)) {
      throw new Error(`Order ${order.id ?? '(unknown)'} has a non-numeric margin.`);
    }
    total += margin;
  }
  return money(total);
}

// --- src/lib/risk.ts -------------------------------------------------
function accountNumber(account, field) {
  const value = account[field];
  if (value === null || value === undefined || value === '') {
    throw new ApiError('INTERNAL_ERROR', `Account data is incomplete: "${field}" is missing.`, {
      account_id: account.id,
      field,
    });
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new ApiError('INTERNAL_ERROR', `Account data is invalid: "${field}" is not a number.`, {
      account_id: account.id,
      field,
    });
  }
  return num;
}

function computeMetrics(account, positions) {
  const balance = accountNumber(account, 'balance');
  const size = accountNumber(account, 'size');
  const dailyStart = accountNumber(account, 'daily_start_balance');

  const unrealized = money(positions.reduce((s, p) => s + p.unrealized_pnl, 0));
  const used = usedMargin(positions);

  return {
    equity: money(balance + unrealized),
    unrealized_pnl: unrealized,
    used_margin: used,
    free_margin: money(balance - used), // not clamped
    open_positions: positions.length,
    daily_dd_limit: money(dailyStart * (1 - Number(account.daily_dd_pct) / 100)),
    max_dd_limit: money(size * (1 - Number(account.max_dd_pct) / 100)),
  };
}

// --- the guard in trade/open -----------------------------------------
function validateOpen(account, positions, required) {
  const m = computeMetrics(account, positions);
  if (required > m.free_margin) {
    throw new ApiError(
      'INSUFFICIENT_MARGIN',
      `Margin $${required} exceeds free margin $${m.free_margin} on account ${account.id} ` +
        `(balance $${Number(account.balance)} − $${m.used_margin} used across ` +
        `${m.open_positions} open position${m.open_positions === 1 ? '' : 's'}).`,
      { account_id: account.id, free_margin: m.free_margin, required_margin: required,
        shortfall: money(required - m.free_margin) },
    );
  }
  return m;
}

// --- fixtures: the account from the bug report -----------------------
const ACCOUNT = {
  id: 'b61c12',
  status: 'active',
  balance: 10000,
  size: 10000,
  daily_start_balance: 10000,
  daily_dd_pct: 4,
  max_dd_pct: 6,
};
const POSITIONS = [
  { id: 'p1', margin: 500, unrealized_pnl: -3.1 },
  { id: 'p2', margin: 608, unrealized_pnl: -3.58 },
];

// --- harness ---------------------------------------------------------
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  FAIL  ${name}\n          ${err.message}`);
    failed += 1;
  }
}

const eq = (actual, expected, label) => {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
};

function throws(fn, code) {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError && err.code === code) return err;
    if (code === 'Error' && err instanceof Error) return err;
    throw new Error(`expected ${code}, got ${err.code ?? err.constructor.name}: ${err.message}`);
  }
  throw new Error(`expected ${code}, nothing thrown`);
}

console.log('\nmetrics match the reported UI state');
test('equity / used / free reproduce 9993.32 / 1108 / 8892', () => {
  const m = computeMetrics(ACCOUNT, POSITIONS);
  eq(m.equity, 9993.32, 'equity');
  eq(m.unrealized_pnl, -6.68, 'unrealized');
  eq(m.used_margin, 1108, 'used_margin');
  eq(m.free_margin, 8892, 'free_margin');
});

console.log('\nthe reported order is accepted');
test('margin 2223 < free 8892 -> accepted', () => {
  const m = validateOpen(ACCOUNT, POSITIONS, 2223);
  eq(m.free_margin, 8892, 'free_margin');
});
test('margin exactly equal to free margin -> accepted', () => {
  validateOpen(ACCOUNT, POSITIONS, 8892);
});
test('first order on an untouched account -> accepted', () => {
  const m = validateOpen(ACCOUNT, [], 2223);
  eq(m.free_margin, 10000, 'free_margin');
});

console.log('\ngenuine shortfalls are still rejected, with both values');
test('margin 1 over free margin -> rejected', () => {
  const err = throws(() => validateOpen(ACCOUNT, POSITIONS, 8893), 'INSUFFICIENT_MARGIN');
  eq(err.details.free_margin, 8892, 'details.free_margin');
  eq(err.details.required_margin, 8893, 'details.required_margin');
  eq(err.details.shortfall, 1, 'details.shortfall');
  if (!err.message.includes('8892') || !err.message.includes('8893')) {
    throw new Error(`message omits a value: ${err.message}`);
  }
  if (!err.message.includes('b61c12')) {
    throw new Error(`message omits the account id: ${err.message}`);
  }
});
test('fully committed account -> rejected with free margin 0', () => {
  const err = throws(
    () => validateOpen(ACCOUNT, [{ id: 'p1', margin: 10000, unrealized_pnl: 0 }], 1),
    'INSUFFICIENT_MARGIN',
  );
  eq(err.details.free_margin, 0, 'details.free_margin');
});

console.log('\nmissing data errors explicitly, never as a margin rejection');
test('null balance -> INTERNAL_ERROR, not INSUFFICIENT_MARGIN', () => {
  const err = throws(
    () => validateOpen({ ...ACCOUNT, balance: null }, POSITIONS, 2223),
    'INTERNAL_ERROR',
  );
  eq(err.details.field, 'balance', 'details.field');
  if (!/incomplete/.test(err.message)) throw new Error(`unclear message: ${err.message}`);
});
test('undefined balance -> INTERNAL_ERROR', () => {
  throws(() => validateOpen({ ...ACCOUNT, balance: undefined }, POSITIONS, 2223), 'INTERNAL_ERROR');
});
test('empty-string balance -> INTERNAL_ERROR (Number("") is 0)', () => {
  throws(() => validateOpen({ ...ACCOUNT, balance: '' }, POSITIONS, 2223), 'INTERNAL_ERROR');
});
test('non-numeric balance -> INTERNAL_ERROR', () => {
  throws(() => validateOpen({ ...ACCOUNT, balance: 'n/a' }, POSITIONS, 2223), 'INTERNAL_ERROR');
});
test('missing size -> INTERNAL_ERROR', () => {
  throws(() => validateOpen({ ...ACCOUNT, size: null }, POSITIONS, 2223), 'INTERNAL_ERROR');
});
test('order with null margin -> throws, does not undercount', () => {
  throws(
    () => validateOpen(ACCOUNT, [{ id: 'p1', margin: null, unrealized_pnl: 0 }], 2223),
    'Error',
  );
});

console.log('\nnumeric strings from PostgREST are handled');
test('balance "10000.00" and margin "500" behave as numbers', () => {
  const m = computeMetrics({ ...ACCOUNT, balance: '10000.00' }, [
    { id: 'p1', margin: '500', unrealized_pnl: -3.1 },
  ]);
  eq(m.used_margin, 500, 'used_margin');
  eq(m.free_margin, 9500, 'free_margin');
});

console.log('\nover-commitment is visible instead of clamped to zero');
test('used > balance reports a negative free margin', () => {
  const m = computeMetrics(ACCOUNT, [{ id: 'bad', margin: 221600, unrealized_pnl: 0 }]);
  eq(m.free_margin, -211600, 'free_margin');
});
test('over-committed rejection surfaces the negative figure', () => {
  const err = throws(
    () => validateOpen(ACCOUNT, [{ id: 'bad', margin: 221600, unrealized_pnl: 0 }], 2223),
    'INSUFFICIENT_MARGIN',
  );
  eq(err.details.free_margin, -211600, 'details.free_margin');
});

console.log('\nposition maths at 200x (the order in the report)');
test('liquidation distance is 100/leverage', () => {
  eq(money((100 / 200) * 100) / 100, 0.5, 'distance %');
});
test('round-trip spread on 444,600 notional is 444.60', () => {
  eq(money(2223 * 200 * (5 / 10000) * 2), 444.6, 'spread cost');
});

console.log(
  failed === 0
    ? `\nALL PASS (${passed} assertions)\n`
    : `\n${failed} FAILED, ${passed} passed\n`,
);
process.exit(failed === 0 ? 0 : 1);
