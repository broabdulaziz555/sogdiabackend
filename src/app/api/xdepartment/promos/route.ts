import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireXDepartment } from '@/lib/permissions';
import { getSettings } from '@/lib/settings';
import { findPromo, promoStatus, promoUses, writePromo } from '@/lib/promos';
import { audit } from '@/lib/audit';
import { promoCreateSchema } from '@/lib/validation';
import type { Promo } from '@/config/settings';

export const dynamic = 'force-dynamic';

/**
 * GET /api/xdepartment/promos
 * Every promo in the settings document, with redemption counts.
 */
export const GET = handle(async (req) => {
  await requireXDepartment(req);
  const { settings, version } = await getSettings();

  const promos = await Promise.all(
    settings.promos.map(async (promo) => {
      const uses = await promoUses(promo.code);
      return {
        ...promo,
        note: promo.note ?? null,
        uses,
        remaining: promo.max_uses > 0 ? Math.max(promo.max_uses - uses, 0) : null,
        status: promoStatus(promo, uses),
      };
    }),
  );

  return ok({ promos, count: promos.length, settings_version: version });
});

/**
 * POST /api/xdepartment/promos
 * Create a promo. Adds one line to the settings document — comments and
 * the rest of the file are left exactly as they were.
 */
export const POST = handle(async (req) => {
  const staff = await requireXDepartment(req);
  const body = promoCreateSchema.parse(await readJson(req));

  if (await findPromo(body.code)) {
    throw new ApiError('DUPLICATE', `Promo ${body.code} already exists.`);
  }
  if (body.kind === 'percent' && body.value > 90) {
    throw new ApiError('VALIDATION_ERROR', 'Percent discounts are capped at 90%.');
  }

  const promo: Promo = {
    code: body.code,
    kind: body.kind,
    value: body.value,
    plans: body.plans,
    expires_at: body.expires_at,
    max_uses: body.max_uses,
    max_per_user: body.max_per_user,
    active: body.active,
    ...(body.note ? { note: body.note } : {}),
  };

  const result = await writePromo(promo.code, promo, staff.id);

  await audit(
    staff,
    'promo.create',
    { type: 'promo', id: promo.code },
    { promo, reason: body.reason ?? null, settings_version: result.version },
    req,
  );

  return ok({
    promo: { ...promo, note: promo.note ?? null, uses: 0, remaining: promo.max_uses || null, status: promoStatus(promo, 0) },
    settings_version: result.version,
    raw: result.raw,
  });
});
