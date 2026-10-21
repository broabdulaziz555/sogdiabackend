import { ApiError, handle, ok } from '@/lib/http';
import { requireXDepartment } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { audit } from '@/lib/audit';
import type { DbUser } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/xdepartment/impersonate/{userId}
 *
 * Mints a one-time sign-in token for support/debugging. The frontend
 * exchanges `token_hash` via supabase.auth.verifyOtp({ type: 'magiclink' })
 * to obtain that user's session. Always audit-logged, and the target is
 * notified — impersonation is powerful, not secret.
 */
export const POST = handle(async (req: Request, ctx: { params: { userId: string } }) => {
  const staff = await requireXDepartment(req);
  const admin = supabaseAdmin();

  const { data: target } = await admin
    .from('users')
    .select('*')
    .eq('id', ctx.params.userId)
    .maybeSingle<DbUser>();

  if (!target) throw new ApiError('NOT_FOUND', 'User not found.');

  const { data, error } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: target.email,
  });

  if (error || !data?.properties) {
    throw new ApiError('INTERNAL_ERROR', error?.message ?? 'Could not mint an impersonation token.');
  }

  await audit(
    staff,
    'user.impersonate',
    { type: 'user', id: target.id },
    { email: target.email },
    req,
  );

  return ok({
    user: { id: target.id, email: target.email, role: target.role },
    token_hash: data.properties.hashed_token,
    action_link: data.properties.action_link,
    expires_in: 3600,
  });
});
