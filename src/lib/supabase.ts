import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { requireEnv } from '@/lib/http';

/**
 * Service-role client. Bypasses RLS — server-side only, never send this
 * key to a browser. All writes in this backend go through here, with
 * ownership checks enforced in code (see lib/auth.ts).
 */
let cached: SupabaseClient | null = null;

/**
 * Every database / auth call gets a hard deadline. Without one, a stalled connection (common on long cross-region
 * links) makes Node wait up to five minutes, and the per-account order lock then holds every later order behind it.
 * Reads are retried once; writes are never retried automatically, so an order can not be stored twice.
 */
const DB_TIMEOUT_MS = 10_000;
/** Writes get longer: aborting one that is already committing only creates doubt (the client's retries are idempotent either way). */
const DB_WRITE_TIMEOUT_MS = 20_000;

const timedFetch: typeof fetch = async (input, init) => {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const where = (() => { try { return new URL(input instanceof Request ? input.url : String(input)).pathname; } catch { return '?'; } })();
  const t0 = Date.now();
  const attempt = () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), method === 'GET' || method === 'HEAD' ? DB_TIMEOUT_MS : DB_WRITE_TIMEOUT_MS);
    const outer = init?.signal;
    if (outer) { if (outer.aborted) ctl.abort(); else outer.addEventListener('abort', () => ctl.abort(), { once: true }); }
    return fetch(input, { ...init, signal: ctl.signal }).finally(() => clearTimeout(timer));
  };
  try {
    const res = await attempt();
    const ms = Date.now() - t0;
    if (ms > 1500) console.warn(`[db] slow ${ms}ms ${method} ${where}`);
    return res;
  } catch (err) {
    console.error(`[db] FAILED after ${Date.now() - t0}ms ${method} ${where}`, (err as Error)?.name);
    if ((method === 'GET' || method === 'HEAD') && !init?.signal?.aborted) return attempt(); // a caller that gave up is not retried
    throw err;
  }
};

export function supabaseAdmin(): SupabaseClient {
  if (cached) return cached;
  cached = createClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false }, global: { fetch: timedFetch } },
  );
  return cached;
}

/** Anon client — used only for sign-up / sign-in / token refresh. */
export function supabaseAnon(): SupabaseClient {
  return createClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
