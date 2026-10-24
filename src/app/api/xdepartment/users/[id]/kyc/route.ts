import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireXDepartment } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { audit } from '@/lib/audit';
import { forceKycSchema } from '@/lib/validation';
import type { DbUser } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/xdepartment/users/{id}/kyc
 * Force any KYC state, including resetting a verified user back to
 * not_submitted. Bypasses the normal approve/reject flow.
 */
export const POST = handle(async (req: Request, ctx: { params: { id: string } }) => {
  const staff = await requireXDepartment(req);
  const body = forceKycSchema.parse(await readJson(req));

  const { data, error } = await supabaseAdmin()
    .from('users')
    .update({ kyc_status: body.kyc_status, kyc_note: body.note ?? null })
    .eq('id', ctx.params.id)
    .select('*')
    .maybeSingle<DbUser>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  if (!data) throw new ApiError('NOT_FOUND', 'User not found.');

  await audit(
    staff,
    'kyc.force',
    { type: 'user', id: data.id },
    { kyc_status: body.kyc_status, note: body.note ?? null },
    req,
  );

  return ok({ user: { id: data.id, email: data.email, kyc_status: data.kyc_status } });
});
