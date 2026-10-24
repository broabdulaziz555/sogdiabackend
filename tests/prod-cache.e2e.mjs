// Run: npm run test:cache   (builds the app, starts the PRODUCTION server and a fake Supabase, changes the data between requests)
// Why it exists: with `export const dynamic = 'force-dynamic'` alone, Next 14 still served Supabase REST GETs from its data cache,
// so a deleted account kept being listed. Mocked unit tests cannot see that; only a real `next start` can.
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
if (!process.env.SKIP_BUILD) execFileSync('node', ['node_modules/next/dist/bin/next', 'build'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });
const USER = '22222222-2222-4222-8222-222222222222';
const staff = { id: USER, role: 'admin', email: 'a@a', kyc_status: 'none' };
let accounts = [1, 2, 3, 4].map((i) => ({ id: `0000000${i}-0000-4000-8000-000000000000`, user_id: USER, type: 'one_step', size: 10000, balance: 10000, equity: 10000, daily_start_balance: 10000, status: 'active', max_leverage: 100, daily_dd_pct: 4, max_dd_pct: 6, profit_target_pct: 8, payout_split_pct: 80, payout_cycle_days: 14, created_at: new Date(Date.now() - i * 1000).toISOString(), users: { email: 'a@a', full_name: 'A' } }));
let hits = 0;
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const send = (b, s = 200, h = {}) => { res.writeHead(s, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(b)); };
  if (u.pathname.startsWith('/auth/v1/user')) return send({ id: USER, aud: 'authenticated' });
  const obj = (req.headers.accept || '').includes('pgrst.object');
  if (u.pathname === '/rest/v1/users') return obj ? send(staff) : send([staff]);
  if (u.pathname === '/rest/v1/accounts') { hits++; return send(accounts, 200, { 'content-range': `0-${Math.max(accounts.length - 1, 0)}/${accounts.length}` }); }
  send([]);
});
await new Promise((r) => fake.listen(4010, r));
const env = { ...process.env, NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:4010', SUPABASE_SERVICE_ROLE_KEY: 'x', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'x', CRON_SECRET: 's', PORT: '4011' };
const srv = spawn('node', ['node_modules/next/dist/bin/next', 'start', '-p', '4011'], { cwd: ROOT, env, stdio: 'ignore' });
srv.on('exit', (c) => { if (!done) { console.error('server exited early', c); process.exit(1); } });
let done = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { await fetch('http://127.0.0.1:4011/api/health'); console.error('port 4011 is already in use: stop the other server first'); srv.kill(); process.exit(1); } catch { /* free */ }
for (let i = 0; i < 80; i++) { try { await fetch('http://127.0.0.1:4011/api/health'); break; } catch { await sleep(500); } }
const H = { authorization: 'Bearer tok' };
const get = async (p) => { const r = await fetch('http://127.0.0.1:4011' + p, { headers: H }); return { cc: r.headers.get('cache-control'), j: await r.json() }; };
let bad = 0; const check = (n, c, x) => { console.log(c ? 'ok  ' : 'FAIL', n, c ? '' : JSON.stringify(x)); if (!c) bad++; };
const n = (r) => (r.j.data?.accounts ?? []).length;
for (const p of ['/api/accounts', '/api/admin/accounts']) {
  const a = await get(p); const a2 = await get(p);
  check(`${p}: 4 rows while the database has 4`, n(a) === 4 && n(a2) === 4, a.j);
  check(`${p}: response says no-store`, /no-store/.test(a.cc ?? ''), a.cc);
}
const before = hits;
accounts = []; // the user empties the table
for (const p of ['/api/accounts', '/api/admin/accounts']) {
  const r = await get(p);
  check(`${p}: 0 rows right after the table is emptied (not cached)`, n(r) === 0, r.j);
}
check('every request reached the database', hits >= before + 2, { hits, before });
accounts = [{ ...fakeRow() }];
function fakeRow() { return { id: '99999999-0000-4000-8000-000000000000', user_id: USER, type: 'instant', size: 5000, balance: 5000, equity: 5000, daily_start_balance: 5000, status: 'active', max_leverage: 100, daily_dd_pct: 3, max_dd_pct: 5, profit_target_pct: null, payout_split_pct: 80, payout_cycle_days: 14, created_at: new Date().toISOString(), users: { email: 'a@a', full_name: 'A' } }; }
const r1 = await get('/api/accounts');
check('/api/accounts: a new row shows up immediately', n(r1) === 1 && r1.j.data.accounts[0].id.startsWith('99999999'), r1.j);
const h = await (await fetch('http://127.0.0.1:4011/api/health')).json();
check('health names the database host', h.data.database.host === '127.0.0.1:4010' && h.data.database.accounts === undefined, h.data.database);
const hs = await (await fetch('http://127.0.0.1:4011/api/health', { headers: { 'x-cron-secret': 's' } })).json();
check('health with the cron secret also counts rows', typeof hs.data.database.host === 'string' && 'accounts' in hs.data.database, hs.data.database);
done = true; srv.kill(); fake.close(); console.log(bad ? `${bad} FAILED` : 'ALL PASS'); process.exit(bad ? 1 : 0);
