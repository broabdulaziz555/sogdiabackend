import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireStaff } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { audit } from '@/lib/audit';
import { notify } from '@/lib/notifications';
import { adminKycSchema } from '@/lib/validation';
import type { DbUser } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** POST /api/admin/kyc/{userId} — approve or reject a KYC submission. */
export const POST = handle(async (req: Request, ctx: { params: { userId: string } }) => {
  const staff = await requireStaff(req);
  const body = adminKycSchema.parse(await readJson(req));
  const approved = body.action === 'approve';

  const { data, error } = await supabaseAdmin()
    .from('users')
    .update({
      kyc_status: approved ? 'verified' : 'rejected',
      kyc_note: body.note ?? null,
    })
    .eq('id', ctx.params.userId)
    .select('*')
    .maybeSingle<DbUser>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  if (!data) throw new ApiError('NOT_FOUND', 'User not found.');

  await audit(
    staff,
    approved ? 'kyc.approve' : 'kyc.reject',
    { type: 'user', id: data.id },
    { note: body.note ?? null },
    req,
  );

  await notify(
    data.id,
    approved ? 'kyc_verified' : 'kyc_rejected',
    approved ? 'KYC verified' : 'KYC rejected',
    approved
      ? 'Your identity is verified. Payouts are now available.'
      : body.note ?? 'Your KYC submission was rejected. Please re-upload a clear document.',
  );

  return ok({
    user: {
      id: data.id,
      email: data.email,
      role: data.role,
      kyc_status: data.kyc_status,
      kyc_note: data.kyc_note,
      wallet_address: data.wallet_address,
      full_name: data.full_name,
      country: data.country,
      created_at: data.created_at,
    },
  });
});
