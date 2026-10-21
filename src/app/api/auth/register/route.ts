import { ApiError, handle, ok, readJson } from '@/lib/http';
import { supabaseAdmin, supabaseAnon } from '@/lib/supabase';
import { registerSchema } from '@/lib/validation';
import { generateReferralCode, resolveReferrer } from '@/lib/referrals';
import { clientIp, rateLimit } from '@/lib/ratelimit';
import type { DbUser } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** POST /api/auth/register */
export const POST = handle(async (req) => {
  rateLimit(`register:${clientIp(req)}`, 5, 60 * 60_000);
  const body = registerSchema.parse(await readJson(req));

  const { data, error } = await supabaseAnon().auth.signUp({
    email: body.email,
    password: body.password,
    options: { data: { full_name: body.full_name ?? null } },
  });

  if (error) {
    const duplicate = /already registered|already exists/i.test(error.message);
    throw new ApiError(
      duplicate ? 'DUPLICATE' : 'VALIDATION_ERROR',
      duplicate ? 'That email is already registered.' : error.message,
    );
  }
  if (!data.user) {
    throw new ApiError('INTERNAL_ERROR', 'Sign-up did not return a user.');
  }

  // The on_auth_user_created trigger inserts the profile row; enrich it here.
  const admin = supabaseAdmin();
  const referredBy = body.referral_code ? await resolveReferrer(body.referral_code) : null;

  await admin
    .from('users')
    .update({
      ...(body.full_name ? { full_name: body.full_name } : {}),
      ...(body.country ? { country: body.country } : {}),
      ...(referredBy && referredBy !== data.user.id ? { referred_by: referredBy } : {}),
      referral_code: generateReferralCode(),
    })
    .eq('id', data.user.id);

  const { data: profile } = await admin
    .from('users')
    .select('id, email, role, kyc_status, wallet_address, full_name, country, referral_code, created_at')
    .eq('id', data.user.id)
    .maybeSingle<DbUser>();

  return ok({
    user: profile ?? { id: data.user.id, email: body.email, role: 'trader', kyc_status: 'not_submitted' },
    session: data.session
      ? {
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          expires_at: data.session.expires_at ?? null,
        }
      : null,
    email_confirmation_required: !data.session,
  });
});
