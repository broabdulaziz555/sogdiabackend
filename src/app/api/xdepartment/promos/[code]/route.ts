import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireXDepartment } from '@/lib/permissions';
import { mergePromo } from '@/lib/settings';
import { findPromo, promoStatus, promoUses, writePromo } from '@/lib/promos';
import { audit } from '@/lib/audit';
import { promoUpdateSchema } from '@/lib/validation';
import type { Promo } from '@/config/settings';

export const dynamic = 'force-dynamic';

async function load(code: string): Promise<Promo> {
  const promo = await findPromo(code);
  if (!promo) throw new ApiError('NOT_FOUND', `Promo ${code.toUpperCase()} does not exist.`);
  return promo;
}

/** GET /api/xdepartment/promos/{code} */
export const GET = handle(async (req: Request, ctx: { params: { code: string } }) => {
  await requireXDepartment(req);
  const promo = await load(ctx.params.code);
  const uses = await promoUses(promo.code);

  return ok({
    promo: {
      ...promo,
      note: promo.note ?? null,
      uses,
      remaining: promo.max_uses > 0 ? Math.max(promo.max_uses - uses, 0) : null,
      status: promoStatus(promo, uses),
    },
  });
});

/**
 * PATCH /api/xdepartment/promos/{code}
 * Change any field. The code itself is immutable — redemptions already
 * reference it; delete and recreate if you need a different code.
 */
export const PATCH = handle(async (req: Request, ctx: { params: { code: string } }) => {
  const staff = await requireXDepartment(req);
  const body = promoUpdateSchema.parse(await readJson(req));
  const current = await load(ctx.params.code);

  const next = mergePromo(current, {
    ...(body.kind !== undefined ? { kind: body.kind } : {}),
    ...(body.value !== undefined ? { value: body.value } : {}),
    ...(body.plans !== undefined ? { plans: body.plans } : {}),
    ...(body.expires_at !== undefined ? { expires_at: body.expires_at } : {}),
    ...(body.max_uses !== undefined ? { max_uses: body.max_uses } : {}),
    ...(body.active !== undefined ? { active: body.active } : {}),
    ...(body.note !== undefined ? { note: body.note ?? undefined } : {}),
  });

  if (next.kind === 'percent' && next.value > 90) {
    throw new ApiError('VALIDATION_ERROR', 'Percent discounts are capped at 90%.');
  }

  const result = await writePromo(current.code, next, staff.id);
  const uses = await promoUses(next.code);

  await audit(
    staff,
    'promo.update',
    { type: 'promo', id: current.code },
    { before: current, after: next, reason: body.reason ?? null, settings_version: result.version },
    req,
  );

  return ok({
    promo: {
      ...next,
      note: next.note ?? null,
      uses,
      remaining: next.max_uses > 0 ? Math.max(next.max_uses - uses, 0) : null,
      status: promoStatus(next, uses),
    },
    settings_version: result.version,
  });
});

/**
 * DELETE /api/xdepartment/promos/{code}
 * Removes the line from the settings document. Past redemptions keep
 * their recorded code on the transaction, so revenue history is intact —
 * but the code stops working immediately and nothing remembers its terms.
 * To pause a promo instead, PATCH it with `active: false`.
 */
export const DELETE = handle(async (req: Request, ctx: { params: { code: string } }) => {
  const staff = await requireXDepartment(req);
  const promo = await load(ctx.params.code);
  const uses = await promoUses(promo.code);

  const result = await writePromo(promo.code, null, staff.id);

  await audit(
    staff,
    'promo.delete',
    { type: 'promo', id: promo.code },
    { promo, redemptions: uses, settings_version: result.version },
    req,
  );

  return ok({
    deleted: true,
    code: promo.code,
    redemptions: uses,
    settings_version: result.version,
    remaining_promos: result.promos.length,
  });
});
