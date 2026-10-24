import { handle, ok, readJson } from '@/lib/http';
import { requireXDepartment } from '@/lib/permissions';
import { getSettings, parseSettings, saveSettings, serializeSettings } from '@/lib/settings';
import { DEFAULT_SETTINGS, DEFAULT_SETTINGS_RAW } from '@/config/settings';
import { audit } from '@/lib/audit';
import { settingsSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/xdepartment/settings
 * Returns the raw blob for the textarea, plus the parsed form and the
 * shipped defaults so the UI can offer a "reset" button.
 */
export const GET = handle(async (req) => {
  await requireXDepartment(req);
  const current = await getSettings();

  return ok({
    raw: current.raw,
    parsed: current.settings,
    version: current.version,
    updated_at: current.updated_at,
    updated_by: current.updated_by,
    default_raw: DEFAULT_SETTINGS_RAW,
    default_parsed: DEFAULT_SETTINGS,
  });
});

/**
 * PUT /api/xdepartment/settings
 * Saves the whole document. Parse failures return every problem with a
 * line number, and nothing is written. `validate_only: true` is a dry run.
 */
export const PUT = handle(async (req) => {
  const staff = await requireXDepartment(req);
  const body = settingsSchema.parse(await readJson(req));

  if (body.validate_only) {
    const { settings, warnings } = parseSettings(body.raw);
    return ok({
      valid: true,
      validate_only: true,
      parsed: settings,
      warnings,
      normalized_raw: serializeSettings(settings),
    });
  }

  const before = await getSettings();
  const saved = await saveSettings(body.raw, staff.id);

  await audit(
    staff,
    'settings.update',
    { type: 'settings', id: 'global' },
    {
      version: saved.version,
      reason: body.reason ?? null,
      before: before.settings,
      after: saved.settings,
    },
    req,
  );

  return ok({
    valid: true,
    raw: saved.raw,
    parsed: saved.settings,
    version: saved.version,
    updated_at: saved.updated_at,
    warnings: saved.warnings,
    normalized_raw: serializeSettings(saved.settings),
  });
});
