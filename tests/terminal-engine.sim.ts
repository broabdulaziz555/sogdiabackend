// Run: npx tsx tests/terminal-engine.sim.ts   (fake Supabase + Binance, real route handlers)
// Fake PostgREST + Binance, then drive the REAL route handlers.
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://sb.local';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'x';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'x';

const USER = '22222222-2222-4222-8222-222222222222', ACC = '11111111-1111-4111-8111-111111111111';
const db: Record<string, any[]> = {
  users: [{ id: USER, role: 'trader', email: 't@t', kyc_status: 'none' }],
  accounts: [{ id: ACC, user_id: USER, type: 'one_step', size: 10000, balance: 10000, equity: 10000, daily_start_balance: 10000, status: 'active', max_leverage: 200, daily_dd_pct: 4, max_dd_pct: 6, profit_target_pct: 8, payout_split_pct: 80, payout_cycle_days: 14, min_trading_days: 0, consistency_pct: null }],
  orders: [],
  pending_orders: [] as any[],
};
let pendingEnabled = true;
let binanceDown = false;
let hangOrderInsert = false;
let prices: Record<string, number> = { BTCUSDT: 81500, PEPEUSDT: 0.0000044, ETHUSDT: 3200 };
let nid = 0;

function match(row: any, q: URLSearchParams) {
  for (const [k, v] of q) {
    if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
    if (k === 'or') { if (!['working', 'failed'].includes(row.status)) return false; continue; }
    if (v.startsWith('eq.') && String(row[k]) !== v.slice(3)) return false;
    if (v.startsWith('in.')) { const l = v.slice(4, -1).split(','); if (!l.includes(String(row[k]))) return false; }
  }
  return true;
}
const j = (b: any, s = 200, h: any = {}) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...h } });

(globalThis as any).fetch = async (input: any, init: any = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? input.toString());
  const method = (init.method ?? 'GET').toUpperCase();
  const accept = new Headers(init.headers).get('accept') ?? '';
  if (url.host === 'sb.local') {
    if (url.pathname.startsWith('/auth/v1/user')) return j({ id: USER, aud: 'authenticated' });
    if (url.pathname.startsWith('/auth/v1/token')) { const b = JSON.parse(init.body); return b.password === 'pw' ? j({ access_token: 'a', refresh_token: 'r', expires_in: 3600, expires_at: 1, token_type: 'bearer', user: { id: USER, email: 't@t' } }) : j({ error: 'invalid_grant', error_description: 'Invalid login credentials' }, 400); }
    if (url.pathname.startsWith('/rest/v1/rpc/close_position')) {
      const a = JSON.parse(init.body);
      const o = db.orders.find((x) => x.id === a.p_order_id && x.status === 'open');
      if (!o) return j({ message: 'ORDER_NOT_OPEN', code: 'P0001' }, 400);
      Object.assign(o, { close_price: a.p_close_price, pnl: a.p_pnl, status: a.p_status, close_reason: a.p_reason, closed_at: new Date().toISOString() });
      const ac = db.accounts.find((x) => x.id === o.account_id)!; ac.balance += a.p_pnl; ac.equity += a.p_pnl;
      return j(o);
    }
    const table = url.pathname.split('/').pop()!;
    if (table === 'pending_orders' && !pendingEnabled) return j({ code: 'PGRST205', message: "Could not find the table 'public.pending_orders' in the schema cache" }, 404);
    const rows = db[table] ?? [];
    if (method === 'POST' && table === 'orders' && hangOrderInsert) await new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))));
    if (method === 'POST') {
      const b = JSON.parse(init.body); const arr = Array.isArray(b) ? b : [b];
      if (arr.some((r) => r.id && rows.some((x) => x.id === r.id))) return j({ code: '23505', message: 'duplicate key' }, 409);
      const made = arr.map((r) => { const n = { id: crypto.randomUUID(), status: table === 'pending_orders' ? 'working' : 'open', updated_at: new Date().toISOString(), created_at: new Date().toISOString(), ...r }; rows.push(n); return n; });
      return j(accept.includes('pgrst.object') ? made[0] : made, 201);
    }
    if (method === 'PATCH') {
      const b = JSON.parse(init.body); const hit = rows.filter((r) => match(r, url.searchParams)); hit.forEach((r) => Object.assign(r, b));
      return j(accept.includes('pgrst.object') ? hit[0] : hit);
    }
    const hit = rows.filter((r) => match(r, url.searchParams));
    if (accept.includes('pgrst.object')) return hit.length ? j(hit[0]) : j({ code: 'PGRST116', message: 'none', details: '0 rows' }, 406);
    return j(hit, 200, { 'content-range': `0-${Math.max(hit.length - 1, 0)}/${hit.length}` });
  }
  if (url.host.includes('binance')) {
    if (binanceDown) return j({ msg: 'down' }, 503);
    const syms = url.searchParams.get('symbols');
    const list = syms ? JSON.parse(syms) : Object.keys(prices);
    return j(list.map((s: string) => ({ symbol: s, price: String(prices[s]) })));
  }
  throw new Error('unmocked ' + url);
};

const hdr = { authorization: 'Bearer tok', 'content-type': 'application/json' };
const call = async (mod: any, method: string, path: string, body?: any) => {
  const req = new Request('http://x' + path, { method, headers: hdr, body: body ? JSON.stringify(body) : undefined });
  const r = await mod[method](req, { params: {} });
  return r.json();
};


let fails = 0;
const check = (name: string, cond: boolean, extra?: any) => { console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra)); if (!cond) fails++; };

(async () => {
  const open = await import('../src/app/api/trade/open/route');
  const close = await import('../src/app/api/trade/close/route');
  const pos = await import('../src/app/api/trade/positions/route');
  const pend = await import('../src/app/api/trade/pending/route');
  const cancel = await import('../src/app/api/trade/pending/cancel/route');
  const list = async () => (await call(pos, 'GET', `/api/trade/positions?account_id=${ACC}`)).data;
  const O = (body: any) => call(open, 'POST', '/api/trade/open', { account_id: ACC, ...body });

  // 1 idempotent open: same id sequentially and concurrently
  const id1 = crypto.randomUUID();
  const r1 = await O({ order_id: id1, symbol: 'BTCUSDT', side: 'long', leverage: 10, margin: 1000 });
  const r2 = await O({ order_id: id1, symbol: 'BTCUSDT', side: 'long', leverage: 10, margin: 1000 });
  check('open ok', r1.ok && r1.data.order.id === id1 && !r1.data.replayed, r1);
  check('retry returns same order, replayed', r2.ok && r2.data.order.id === id1 && r2.data.replayed === true, r2);
  check('only one row', db.orders.filter((o) => o.id === id1).length === 1);
  const id2 = crypto.randomUUID();
  const burst = await Promise.all([1, 2, 3, 4].map(() => O({ order_id: id2, symbol: 'ETHUSDT', side: 'short', leverage: 5, margin: 500 })));
  check('concurrent same id -> one position', burst.every((b) => b.ok) && db.orders.filter((o) => o.id === id2).length === 1, burst.map((b) => b.ok));
  check('margin used once', (await list()).metrics.used_margin === 1500, (await list()).metrics);

  // 2 id owned by another account is refused
  db.orders.push({ id: '99999999-9999-4999-8999-999999999999', account_id: 'other', user_id: 'other', status: 'open', symbol: 'BTCUSDT', side: 'long', margin: 1, mark_price_at_open: 1, liquidation_price: 1, entry_price: 1, quantity: 1, leverage: 1, position_size: 1 });
  const steal = await O({ order_id: '99999999-9999-4999-8999-999999999999', symbol: 'BTCUSDT', side: 'long', leverage: 2, margin: 10 });
  check('foreign id refused', !steal.ok && steal.error.code === 'DUPLICATE', steal);

  // 3 margin guard still holds
  const big = await O({ order_id: crypto.randomUUID(), symbol: 'BTCUSDT', side: 'long', leverage: 2, margin: 99999 });
  check('insufficient margin rejected', !big.ok && big.error.code === 'INSUFFICIENT_MARGIN', big);

  // 4 close, then retry close
  const c1 = await call(close, 'POST', '/api/trade/close', { order_id: id1 });
  const c2 = await call(close, 'POST', '/api/trade/close', { order_id: id1 });
  check('close ok with metrics', c1.ok && c1.data.metrics.open_positions === 1 && c1.data.order.status === 'closed', c1);
  check('second close = ORDER_NOT_OPEN', !c2.ok && c2.error.code === 'ORDER_NOT_OPEN', c2);
  const replayClosed = await O({ order_id: id1, symbol: 'BTCUSDT', side: 'long', leverage: 10, margin: 1000 });
  check('re-sent open of closed order does not reopen', replayClosed.ok && replayClosed.data.replayed && db.orders.filter((o) => o.id === id1 && o.status === 'open').length === 0, replayClosed);

  // 5 pending limit: placed, not crossed, then crossed by the poll
  const pid = crypto.randomUUID();
  const px = prices.BTCUSDT;
  const p1 = await call(pend, 'POST', '/api/trade/pending', { id: pid, account_id: ACC, symbol: 'BTCUSDT', side: 'long', kind: 'limit', trigger_price: px * 0.99, leverage: 10, margin: 300 });
  const p1b = await call(pend, 'POST', '/api/trade/pending', { id: pid, account_id: ACC, symbol: 'BTCUSDT', side: 'long', kind: 'limit', trigger_price: px * 0.99, leverage: 10, margin: 300 });
  check('pending created idempotently', p1.ok && p1b.ok && db.pending_orders.length === 1, [p1, p1b]);
  let l = await list();
  check('pending listed, not filled', l.pending.length === 1 && l.pending[0].status === 'working' && !l.positions.some((p: any) => p.id === pid), l.pending);
  prices.BTCUSDT = px * 0.985; await new Promise((r) => setTimeout(r, 1700));
  l = await Promise.all([list(), list(), list()]).then((r) => r[2]);
  const filled = db.orders.filter((o) => o.id === pid);
  check('limit filled once at its own price or better', filled.length === 1 && filled[0].entry_price <= px * 0.99 + 1e-6, filled);
  check('pending no longer working', db.pending_orders[0].status === 'filled' && l.pending.length === 0, db.pending_orders[0]);
  check('filled position listed under pending id', l.positions.some((p: any) => p.id === pid));

  // 6 stop: long stop above market fills at market after cross
  const sid = crypto.randomUUID();
  await call(pend, 'POST', '/api/trade/pending', { id: sid, account_id: ACC, symbol: 'ETHUSDT', side: 'long', kind: 'stop', trigger_price: prices.ETHUSDT * 1.01, leverage: 5, margin: 200 });
  prices.ETHUSDT *= 1.02; await new Promise((r) => setTimeout(r, 1700)); await list();
  const so = db.orders.find((o) => o.id === sid);
  check('stop filled at market (>= trigger)', !!so && so.entry_price >= prices.ETHUSDT / 1.02 * 1.01 * 0.999, so);

  // 7 cancel
  const cid = crypto.randomUUID();
  await call(pend, 'POST', '/api/trade/pending', { id: cid, account_id: ACC, symbol: 'BTCUSDT', side: 'short', kind: 'limit', trigger_price: prices.BTCUSDT * 1.2, leverage: 3, margin: 100 });
  const cc = await call(cancel, 'POST', '/api/trade/pending/cancel', { id: cid, account_id: ACC });
  l = await list();
  check('cancelled order disappears and never fills', cc.ok && !l.pending.some((p: any) => p.id === cid), l.pending);

  // 8 pending that cannot fill (margin) ends as failed with a reason
  const fid = crypto.randomUUID();
  await call(pend, 'POST', '/api/trade/pending', { id: fid, account_id: ACC, symbol: 'PEPEUSDT', side: 'long', kind: 'stop', trigger_price: prices.PEPEUSDT * 0.5, leverage: 2, margin: 9000 });
  l = await list();
  const f = l.pending.find((p: any) => p.id === fid);
  check('unfillable pending is failed with reason', f?.status === 'failed' && /margin/i.test(f.error ?? ''), f);

  // 9 migration missing: positions still work, create says FEATURE_UNAVAILABLE
  pendingEnabled = false;
  l = await list();
  check('poll survives missing table', Array.isArray(l.positions) && Array.isArray(l.pending) && l.pending.length === 0);
  const un = await call(pend, 'POST', '/api/trade/pending', { account_id: ACC, symbol: 'BTCUSDT', side: 'long', kind: 'limit', trigger_price: 1, leverage: 3, margin: 10 });
  check('create reports FEATURE_UNAVAILABLE', !un.ok && un.error.code === 'FEATURE_UNAVAILABLE', un);

  // 9b a price that cannot be had must never hide a position or fail the poll
  const before = (await list()).positions.length;
  const stray = (id: string, symbol: string) => ({ id, account_id: ACC, user_id: USER, status: 'open', symbol, side: 'long', margin: 50, leverage: 2, position_size: 100, quantity: 1, entry_price: 100, mark_price_at_open: 100, liquidation_price: 50, take_profit: null, stop_loss: 100.5, created_at: new Date().toISOString() });
  db.orders.push(stray('aaaaaaaa-1111-4111-8111-111111111111', 'XRPUSDT'), stray('bbbbbbbb-1111-4111-8111-111111111111', 'NOSUCHUSDT'));
  binanceDown = true;
  const down = await call(pos, 'GET', `/api/trade/positions?account_id=${ACC}`);
  binanceDown = false;
  const fb = down.ok ? down.data.positions.filter((x: any) => x.id.endsWith('1111-4111-8111-111111111111')) : [];
  check('prices unavailable: poll still answers and lists every position', down.ok && down.data.positions.length === before + 2 && down.data.debug.db_open_orders === before + 2, down.ok ? down.data.debug : down);
  check('fallback positions are priced at their open price, as numbers', fb.length === 2 && fb.every((x: any) => x.price_source === 'fallback' && x.mark_price === 100 && typeof x.entry_price === 'number'), fb);
  check('a stand-in price never triggers a stop-loss (SL above the stand-in would fire on a live price)', db.orders.filter((o) => o.id.endsWith('1111-4111-8111-111111111111') && o.status === 'open').length === 2);
  db.orders = db.orders.filter((o) => !o.id.endsWith('1111-4111-8111-111111111111'));

  // 9c opens fired together can never overspend the free margin (reads start before the lock; stale ones are re-read)
  const freeNow = (await list()).metrics.free_margin;
  const race = await Promise.all([1, 2, 3, 4].map(() => O({ order_id: crypto.randomUUID(), symbol: 'ETHUSDT', side: 'long', leverage: 2, margin: Math.floor(freeNow * 0.6) })));
  check('4 concurrent opens of 60% of free margin: exactly one is accepted', race.filter((r) => r.ok).length === 1 && race.filter((r) => !r.ok && r.error.code === 'INSUFFICIENT_MARGIN').length === 3, race.map((r) => r.ok || r.error.code));
  check('open answers with the order only (no risk-engine payload)', race.find((r) => r.ok).data.metrics === undefined && race.find((r) => r.ok).data.order.id != null);
  // cleanup so later checks are unaffected
  for (const r of race) if (r.ok) db.orders = db.orders.filter((o) => o.id !== r.data.order.id);

  // 9d the risk engine does NOT run on open: a position past its liquidation price stays open until the positions poll
  const doomed = { id: crypto.randomUUID(), account_id: ACC, user_id: USER, status: 'open', symbol: 'BTCUSDT', side: 'long', margin: 20, leverage: 10, position_size: 200, quantity: 0.002, entry_price: 100000, mark_price_at_open: 100000, liquidation_price: 90000, take_profit: null, stop_loss: null, created_at: new Date().toISOString() };
  db.orders.push(doomed);
  const oo = await O({ order_id: crypto.randomUUID(), symbol: 'ETHUSDT', side: 'long', leverage: 2, margin: 10 });
  await new Promise((r) => setTimeout(r, 300));
  check('open succeeded and did not sweep (doomed position still open right after)', oo.ok && db.orders.find((o) => o.id === doomed.id)!.status === 'open', db.orders.find((o) => o.id === doomed.id)?.status);
  const statusesBefore = JSON.stringify(db.orders.map((o) => [o.id, o.status]));
  const polled = await list();
  const engineOn = process.env.RISK_ENGINE !== 'off';
  if (engineOn) {
    check('engine on (default): the next positions poll liquidates it', db.orders.find((o) => o.id === doomed.id)!.status !== 'open', db.orders.find((o) => o.id === doomed.id)?.status);
  } else {
    check('RISK_ENGINE=off: polling leaves a position past its liquidation price OPEN and lists it', db.orders.find((o) => o.id === doomed.id)!.status === 'open' && polled.positions.some((p: any) => p.id === doomed.id), db.orders.find((o) => o.id === doomed.id)?.status);
    check('RISK_ENGINE=off: a poll changes no order status at all', JSON.stringify(db.orders.map((o) => [o.id, o.status])) === statusesBefore && polled.liquidated.length === 0 && polled.debug.risk_engine === 'off');
    db.orders = db.orders.filter((o) => o.id !== doomed.id);
  }

  // 9e auth: the profile is read while the token is verified; the early read counts only for the verified user
  const jwt = (sub: string) => `h.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.s`;
  const withToken = async (tok: string) => { const r = await pos.GET(new Request(`http://x/api/trade/positions?account_id=${ACC}`, { headers: { authorization: `Bearer ${tok}` } }), { params: {} }); return r.json(); };
  const a1 = await withToken(jwt(USER));
  const a2 = await withToken(jwt('33333333-3333-4333-8333-333333333333')); // claims someone else; the verified user is still USER
  const a3 = await withToken('not-a-jwt');
  check('token claiming the real user: ok', a1.ok === true, a1);
  check('token claiming another user: still the verified user (profile of the claimed one is never used)', a2.ok === true, a2);
  check('opaque token: ok', a3.ok === true, a3);
  const login = await import('../src/app/api/auth/login/route');
  const l1 = await login.POST(new Request('http://x/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'T@t.io', password: 'pw' }) }), { params: {} }).then((r: Response) => r.json());
  const l2 = await login.POST(new Request('http://x/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 't@t.io', password: 'nope' }) }), { params: {} }).then((r: Response) => r.json());
  check('login returns the signed-in user\'s profile and a session', l1.ok && l1.data.user?.id === USER && l1.data.session.access_token === 'a', l1);
  check('wrong password: refused, no profile in the reply', !l2.ok && l2.error.code === 'UNAUTHORIZED' && !('user' in (l2.data ?? {})), l2);

  // 9f a database insert that never answers is cut off after 5 s with an "outcome unknown" error, never a hang
  hangOrderInsert = true;
  const t5 = Date.now();
  const hung = await O({ order_id: crypto.randomUUID(), symbol: 'ETHUSDT', side: 'long', leverage: 2, margin: 5 });
  hangOrderInsert = false;
  const took = Date.now() - t5;
  check('hung insert: answered within ~5 s with UPSTREAM_ERROR (not stored, not a refusal)', !hung.ok && hung.error.code === 'UPSTREAM_ERROR' && took >= 4500 && took < 7500, { took, hung });
  const after = await O({ order_id: crypto.randomUUID(), symbol: 'ETHUSDT', side: 'long', leverage: 2, margin: 5 });
  check('the account lock was released: the next order goes straight through', after.ok, after);

  // 10 cron tick
  db.orders = db.orders.filter((o) => o.account_id !== 'other');
  pendingEnabled = true;
  const tick = await import('../src/app/api/cron/tick/route');
  process.env.CRON_SECRET = 's';
  const tr = await tick.POST(new Request('http://x/api/cron/tick', { method: 'POST', headers: { 'x-cron-secret': 's' } }), { params: {} }); const tj = await tr.json();
  check('cron tick runs', tj.ok && tj.data.failed === 0 && tj.data.accounts >= 1, tj);

  console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
