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

const timedFetch: typeof fetch = async (input, init) => {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const attempt = () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), DB_TIMEOUT_MS);
    const outer = init?.signal;
    if (outer) outer.addEventListener('abort', () => ctl.abort(), { once: true });
    return fetch(input, { ...init, signal: ctl.signal }).finally(() => clearTimeout(timer));
  };
  try {
    return await attempt();
  } catch (err) {
    if (method === 'GET' || method === 'HEAD') return attempt();
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
