import { ApiError, handle, ok, readJson } from '@/lib/http';
import { isAuthUnavailable, supabaseAdmin, supabaseAnon } from '@/lib/supabase';
import { loginSchema } from '@/lib/validation';
import type { DbUser } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** POST /api/auth/login */
export const POST = handle(async (req) => {
  const body = loginSchema.parse(await readJson(req));

  // Password check (auth service) and profile lookup (database) are independent round trips: run them together. The
  // profile found by e-mail is only returned if it belongs to the user who actually signed in.
  const email = body.email.trim().toLowerCase();
  const PROFILE = 'id, email, role, kyc_status, wallet_address, full_name, country, created_at';
  const [signIn, byEmail] = await Promise.all([
    supabaseAnon().auth.signInWithPassword({ email: body.email, password: body.password }),
    supabaseAdmin().from('users').select(PROFILE).ilike('email', email.replace(/[%_\\]/g, '\\$&')).limit(2),
  ]);
  const { data, error } = signIn;

  if (isAuthUnavailable(error)) throw new ApiError('UPSTREAM_ERROR', 'The sign-in service did not answer in time. Try again in a moment.');
  if (error || !data.session || !data.user) {
    throw new ApiError('UNAUTHORIZED', 'Invalid email or password.');
  }

  let profile = (byEmail.data as unknown as DbUser[] | null)?.find((u) => u.id === data.user!.id) ?? null;
  if (!profile) {
    // e-mail on the profile differs from the sign-in e-mail (or the lookup failed): fall back to the id
    const { data: byId } = await supabaseAdmin().from('users').select(PROFILE).eq('id', data.user.id).maybeSingle<DbUser>();
    profile = byId;
  }

  return ok({
    user: profile,
    session: {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at ?? null,
    },
  });
});
