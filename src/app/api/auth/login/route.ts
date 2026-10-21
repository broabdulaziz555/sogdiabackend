import { ApiError, handle, ok, readJson } from '@/lib/http';
import { supabaseAdmin, supabaseAnon } from '@/lib/supabase';
import { loginSchema } from '@/lib/validation';
import type { DbUser } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** POST /api/auth/login */
export const POST = handle(async (req) => {
  const body = loginSchema.parse(await readJson(req));

  const { data, error } = await supabaseAnon().auth.signInWithPassword({
    email: body.email,
    password: body.password,
  });

  if (error || !data.session || !data.user) {
    throw new ApiError('UNAUTHORIZED', 'Invalid email or password.');
  }

  const { data: profile } = await supabaseAdmin()
    .from('users')
    .select('id, email, role, kyc_status, wallet_address, full_name, country, created_at')
    .eq('id', data.user.id)
    .maybeSingle<DbUser>();

  return ok({
    user: profile,
    session: {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at ?? null,
    },
  });
});
