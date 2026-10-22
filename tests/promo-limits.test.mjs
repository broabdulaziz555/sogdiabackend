/**
 * Promo limit semantics.
 *
 * Mirrors the checks in src/lib/promos.ts so the two caps can be
 * exercised without a database.
 *
 *   node tests/promo-limits.test.mjs
 */

const PENDING_HOLD_MS = 2 * 60 * 60 * 1000;

/** Which transactions count against a limit. */
function countsAsRedemption(tx, now = Date.now()) {
  if (tx.type !== 'purchase') return false;
  if (tx.status === 'paid') return true;
  if (tx.status === 'pending') return now - tx.created_at < PENDING_HOLD_MS;
  return false; // failed / rejected / expired
}

function checkPromo(promo, planKey, userId, ledger, now = Date.now()) {
  if (!promo) return { ok: false, reason: 'UNKNOWN_CODE' };
  if (!promo.active) return { ok: false, reason: 'INACTIVE' };
  if (promo.expires_at && Date.parse(`${promo.expires_at}T23:59:59Z`) < now) {
    return { ok: false, reason: 'EXPIRED' };
  }
  if (promo.plans !== 'all' && !promo.plans.includes(planKey)) {
    return { ok: false, reason: 'PLAN_NOT_ELIGIBLE' };
  }

  const redemptions = ledger.filter(
    (t) => t.promo_code === promo.code && countsAsRedemption(t, now),
  );

  if (promo.max_per_user > 0 && userId) {
    const mine = redemptions.filter((t) => t.user_id === userId).length;
    if (mine >= promo.max_per_user) {
      return { ok: false, reason: 'USER_LIMIT_REACHED', user_uses: mine };
    }
  }

  if (promo.max_uses > 0 && redemptions.length >= promo.max_uses) {
    return { ok: false, reason: 'LIMIT_REACHED', uses: redemptions.length };
  }

  return { ok: true, reason: null };
}

const promo = (over = {}) => ({
  code: 'WELCOME10',
  kind: 'percent',
  value: 10,
  plans: 'all',
  expires_at: null,
  max_uses: 0,
  max_per_user: 0,
  active: true,
  ...over,
});

const paid = (user) => ({
  type: 'purchase',
  status: 'paid',
  user_id: user,
  promo_code: 'WELCOME10',
  created_at: Date.now() - 86_400_000,
});

let pass = 0;
let fail = 0;
const t = (name, cond) => {
  console.log((cond ? '  ok    ' : '  FAIL  ') + name);
  cond ? pass++ : fail++;
};

console.log('\nmax_uses:0 + max_per_user:0  -> unlimited, no cap at all');
{
  const p = promo();
  const ledger = Array.from({ length: 500 }, (_, i) => paid(`u${i}`));
  t('500 prior redemptions, new user still ok', checkPromo(p, 'one_step_10k', 'new', ledger).ok);
  t('a user who already used it can use it again', checkPromo(p, 'one_step_10k', 'u1', ledger).ok);
}

console.log('\nmax_uses:0 + max_per_user:1  -> EVERYONE ONCE (what was wanted)');
{
  const p = promo({ max_per_user: 1 });
  const ledger = [paid('alice'), paid('bob')];
  t('a new user can use it', checkPromo(p, 'one_step_10k', 'carol', ledger).ok);
  t('the 10,000th new user can still use it',
    checkPromo(p, 'one_step_10k', 'zzz', Array.from({ length: 10_000 }, (_, i) => paid(`u${i}`))).ok);
  const repeat = checkPromo(p, 'one_step_10k', 'alice', ledger);
  t('alice cannot use it twice', !repeat.ok && repeat.reason === 'USER_LIMIT_REACHED');
  t('the rejection reports her own use count', repeat.user_uses === 1);
}

console.log('\nmax_uses:1  -> ONE USE TOTAL (what was accidentally set)');
{
  const p = promo({ max_uses: 1 });
  t('first ever user can use it', checkPromo(p, 'one_step_10k', 'alice', []).ok);
  const second = checkPromo(p, 'one_step_10k', 'bob', [paid('alice')]);
  t('a DIFFERENT user is then blocked', !second.ok && second.reason === 'LIMIT_REACHED');
}

console.log('\nmax_uses:100 + max_per_user:1  -> first 100 people, once each');
{
  const p = promo({ max_uses: 100, max_per_user: 1 });
  const ledger99 = Array.from({ length: 99 }, (_, i) => paid(`u${i}`));
  t('the 100th new user gets in', checkPromo(p, 'one_step_10k', 'new', ledger99).ok);
  const ledger100 = Array.from({ length: 100 }, (_, i) => paid(`u${i}`));
  t('the 101st is blocked by the global cap',
    checkPromo(p, 'one_step_10k', 'new', ledger100).reason === 'LIMIT_REACHED');
  t('a prior user is blocked by the per-user cap first',
    checkPromo(p, 'one_step_10k', 'u5', ledger99).reason === 'USER_LIMIT_REACHED');
}

console.log('\nwhich transactions consume a use');
{
  const p = promo({ max_per_user: 1 });
  const fresh = (status, ageMs = 0) => ({
    type: 'purchase', status, user_id: 'alice', promo_code: 'WELCOME10',
    created_at: Date.now() - ageMs,
  });
  t('an open invoice holds the use (no double-spend)',
    !checkPromo(p, 'one_step_10k', 'alice', [fresh('pending')]).ok);
  t('a stale pending (>2h) releases it',
    checkPromo(p, 'one_step_10k', 'alice', [fresh('pending', 3 * 60 * 60 * 1000)]).ok);
  t('a failed payment does not consume a use',
    checkPromo(p, 'one_step_10k', 'alice', [fresh('failed')]).ok);
  t('another user\'s paid redemption does not block alice',
    checkPromo(p, 'one_step_10k', 'alice', [paid('bob')]).ok);
}

console.log('\nother gates still apply');
{
  t('inactive', checkPromo(promo({ active: false }), 'one_step_10k', 'a', []).reason === 'INACTIVE');
  t('expired', checkPromo(promo({ expires_at: '2020-01-01' }), 'one_step_10k', 'a', []).reason === 'EXPIRED');
  t('wrong plan', checkPromo(promo({ plans: ['instant_100k'] }), 'one_step_10k', 'a', []).reason === 'PLAN_NOT_ELIGIBLE');
}

console.log(fail === 0 ? `\nALL PASS (${pass} assertions)\n` : `\n${fail} FAILED, ${pass} passed\n`);
process.exit(fail === 0 ? 0 : 1);
