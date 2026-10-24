import { ApiError, handle, ok, readJson, requireEnv } from '@/lib/http';
import { AUTH_TIMEOUT_MS } from '@/lib/supabase';
import { refreshSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/auth/refresh
 *
 * Calls the auth service's refresh endpoint directly: ONE attempt with a hard deadline. (supabase-js retries network
 * failures with back-off for up to ~30 s, and every request of the terminal waits for a refresh when the token is
 * about to expire.)
 *
 *   token rejected by the auth service  -> 401 UNAUTHORIZED   (the client signs the user out)
 *   auth service slow / down / limiting -> 502 UPSTREAM_ERROR  (the client keeps the session and tries again)
 */
export const POST = handle(async (req) => {
  const body = refreshSchema.parse(await readJson(req));

  let res: Response;
  try {
    res = await fetch(`${requireEnv('NEXT_PUBLIC_SUPABASE_URL')}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: body.refresh_token }),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (err) {
    console.error('[auth/refresh] auth service unreachable', err instanceof Error ? err.name : String(err));
    throw new ApiError('UPSTREAM_ERROR', 'The auth service did not answer in time. Your session is still valid; try again in a moment.');
  }

  if (res.status >= 500 || res.status === 429) {
    throw new ApiError('UPSTREAM_ERROR', 'The auth service is busy. Your session is still valid; try again in a moment.');
  }

  const json = (await res.json().catch(() => null)) as { access_token?: string; refresh_token?: string; expires_at?: number } | null;
  if (!res.ok || !json?.access_token || !json.refresh_token) {
    throw new ApiError('UNAUTHORIZED', 'Refresh token is invalid or expired.');
  }

  return ok({
    session: {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: json.expires_at ?? null,
    },
  });
});
