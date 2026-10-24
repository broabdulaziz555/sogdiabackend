import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireXDepartment } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { audit } from '@/lib/audit';
import { notify } from '@/lib/notifications';
import { setRoleSchema } from '@/lib/validation';
import type { DbUser } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/xdepartment/users/{id}/role
 * Promote or demote any user, including granting X-Department clearance.
 */
export const POST = handle(async (req: Request, ctx: { params: { id: string } }) => {
  const staff = await requireXDepartment(req);
  const body = setRoleSchema.parse(await readJson(req));

  if (ctx.params.id === staff.id && body.role !== 'xdepartment') {
    throw new ApiError(
      'VALIDATION_ERROR',
      'Refusing to demote yourself — have another X-Department member do it.',
    );
  }

  const { data, error } = await supabaseAdmin()
    .from('users')
    .update({ role: body.role })
    .eq('id', ctx.params.id)
    .select('*')
    .maybeSingle<DbUser>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  if (!data) throw new ApiError('NOT_FOUND', 'User not found.');

  await audit(
    staff,
    'user.role_change',
    { type: 'user', id: data.id },
    { to: body.role, email: data.email, reason: body.reason ?? null },
    req,
  );

  await notify(data.id, 'admin_action', 'Account role updated', `Your role is now "${body.role}".`);

  return ok({ user: { id: data.id, email: data.email, role: data.role } });
});
