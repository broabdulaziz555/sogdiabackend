import { ApiError, handle, ok, readJson } from '@/lib/http';
import { supabaseAnon } from '@/lib/supabase';
import { refreshSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/** POST /api/auth/refresh */
export const POST = handle(async (req) => {
  const body = refreshSchema.parse(await readJson(req));

  const { data, error } = await supabaseAnon().auth.refreshSession({
    refresh_token: body.refresh_token,
  });

  if (error || !data.session) {
    throw new ApiError('UNAUTHORIZED', 'Refresh token is invalid or expired.');
  }

  return ok({
    session: {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at ?? null,
    },
  });
});
