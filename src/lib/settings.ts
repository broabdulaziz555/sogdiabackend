import { ApiError } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase';
import { PLAN_KEYS } from '@/config/pricing';
import {
  DEFAULT_SETTINGS,
  DEFAULT_SETTINGS_RAW,
  SETTINGS_BOUNDS,
  SETTINGS_NUMERIC_KEYS,
  type PlatformSettings,
  type Promo,
  type SettingsNumericKey,
} from '@/config/settings';

export interface ParseIssue {
  line: number | null;
  message: string;
}

export interface ParseResult {
  settings: PlatformSettings;
  warnings: ParseIssue[];
}

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,23}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NUMERIC_KEY_SET = new Set<string>(SETTINGS_NUMERIC_KEYS);

function invalid(issues: ParseIssue[]): never {
  throw new ApiError(
    'VALIDATION_ERROR',
    issues.length === 1
      ? issues[0].message
      : `${issues.length} problems in the settings document.`,
    issues,
  );
}

// ---------------------------------------------------------------------
// Promo line: promo = CODE | 25% | plans:all | expires:never | max_uses:0 | active
// ---------------------------------------------------------------------
function parsePromoLine(spec: string, line: number, issues: ParseIssue[]): Promo | null {
  const tokens = spec.split('|').map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) {
    issues.push({ line, message: 'Promo line is empty.' });
    return null;
  }

  const code = tokens[0].toUpperCase();
  if (!CODE_RE.test(code)) {
    issues.push({
      line,
      message: `"${tokens[0]}" is not a valid promo code — use 3–24 characters, letters, digits, _ or -.`,
    });
    return null;
  }

  const promo: Promo = {
    code,
    kind: 'percent',
    value: 0,
    plans: 'all',
    expires_at: null,
    max_uses: 0,
    max_per_user: 0,
    active: true,
  };
  let valueSeen = false;

  for (const token of tokens.slice(1)) {
    const lower = token.toLowerCase();

    if (lower === 'active' || lower === 'enabled') {
      promo.active = true;
      continue;
    }
    if (lower === 'inactive' || lower === 'disabled' || lower === 'off') {
      promo.active = false;
      continue;
    }

    // 25%  |  $50  |  50usd
    const pctMatch = token.match(/^(\d+(?:\.\d+)?)\s*%$/);
    if (pctMatch) {
      promo.kind = 'percent';
      promo.value = Number(pctMatch[1]);
      valueSeen = true;
      continue;
    }
    const fixedMatch = token.match(/^\$\s*(\d+(?:\.\d+)?)$|^(\d+(?:\.\d+)?)\s*usd$/i);
    if (fixedMatch) {
      promo.kind = 'fixed';
      promo.value = Number(fixedMatch[1] ?? fixedMatch[2]);
      valueSeen = true;
      continue;
    }

    const sep = token.indexOf(':');
    if (sep === -1) {
      issues.push({ line, message: `Promo ${code}: could not read "${token}".` });
      continue;
    }
    const key = token.slice(0, sep).trim().toLowerCase();
    const value = token.slice(sep + 1).trim();

    switch (key) {
      case 'percent':
        promo.kind = 'percent';
        promo.value = Number(value);
        valueSeen = true;
        break;
      case 'fixed':
      case 'usd':
        promo.kind = 'fixed';
        promo.value = Number(value);
        valueSeen = true;
        break;
      case 'plans':
      case 'plan':
        promo.plans =
          value.toLowerCase() === 'all'
            ? 'all'
            : value.split(',').map((p) => p.trim()).filter(Boolean);
        break;
      case 'expires':
      case 'expires_at':
      case 'until':
        if (value.toLowerCase() === 'never' || value === '-') {
          promo.expires_at = null;
        } else if (DATE_RE.test(value) && !Number.isNaN(Date.parse(value))) {
          promo.expires_at = value;
        } else {
          issues.push({
            line,
            message: `Promo ${code}: expires must be YYYY-MM-DD or "never", got "${value}".`,
          });
        }
        break;
      case 'max_uses':
      case 'uses':
      case 'limit':
        promo.max_uses = Number(value);
        break;
      case 'max_per_user':
      case 'per_user':
      case 'once_per_user':
        promo.max_per_user = Number(value);
        break;
      case 'note':
      case 'label':
        promo.note = value;
        break;
      default:
        issues.push({ line, message: `Promo ${code}: unknown field "${key}".` });
    }
  }

  if (!valueSeen) {
    issues.push({ line, message: `Promo ${code}: no discount given — add "25%" or "$50".` });
    return null;
  }
  if (!Number.isFinite(promo.value) || promo.value <= 0) {
    issues.push({ line, message: `Promo ${code}: discount must be greater than zero.` });
    return null;
  }
  if (promo.kind === 'percent' && promo.value > 90) {
    issues.push({ line, message: `Promo ${code}: percent discount is capped at 90%.` });
    return null;
  }
  if (!Number.isFinite(promo.max_uses) || promo.max_uses < 0) {
    issues.push({ line, message: `Promo ${code}: max_uses must be 0 or more.` });
    return null;
  }
  if (!Number.isFinite(promo.max_per_user) || promo.max_per_user < 0) {
    issues.push({ line, message: `Promo ${code}: max_per_user must be 0 or more.` });
    return null;
  }

  return promo;
}

// ---------------------------------------------------------------------
// Whole document
// ---------------------------------------------------------------------
function validateShape(input: PlatformSettings, issues: ParseIssue[], warnings: ParseIssue[]) {
  for (const key of SETTINGS_NUMERIC_KEYS) {
    const value = input[key];
    const bounds = SETTINGS_BOUNDS[key];
    if (!Number.isFinite(value)) {
      issues.push({ line: null, message: `${key} must be a number.` });
    } else if (value < bounds.min || value > bounds.max) {
      issues.push({
        line: null,
        message: `${key} must be between ${bounds.min} and ${bounds.max} (got ${value}).`,
      });
    }
  }

  const seen = new Set<string>();
  for (const promo of input.promos) {
    if (seen.has(promo.code)) {
      issues.push({ line: null, message: `Promo code ${promo.code} is listed twice.` });
    }
    seen.add(promo.code);

    if (promo.plans !== 'all') {
      for (const plan of promo.plans) {
        if (!PLAN_KEYS.includes(plan)) {
          warnings.push({
            line: null,
            message: `Promo ${promo.code} references unknown plan "${plan}" — it will never match.`,
          });
        }
      }
    }
    if (promo.expires_at && Date.parse(promo.expires_at) < Date.now()) {
      warnings.push({ line: null, message: `Promo ${promo.code} has already expired.` });
    }
  }
}

/** Accepts the line format or raw JSON. Throws ApiError with per-line details. */
export function parseSettings(raw: string): ParseResult {
  const issues: ParseIssue[] = [];
  const warnings: ParseIssue[] = [];
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    invalid([{ line: null, message: 'Settings document is empty.' }]);
  }

  // --- JSON form ---
  if (trimmed.startsWith('{')) {
    let json: Partial<PlatformSettings>;
    try {
      json = JSON.parse(trimmed) as Partial<PlatformSettings>;
    } catch (err) {
      invalid([{ line: null, message: `Invalid JSON: ${(err as Error).message}` }]);
    }

    const settings: PlatformSettings = {
      ...DEFAULT_SETTINGS,
      ...json,
      promos: Array.isArray(json.promos) ? json.promos.map(normalizePromo) : [],
    };
    validateShape(settings, issues, warnings);
    if (issues.length) invalid(issues);
    return { settings, warnings };
  }

  // --- line format ---
  const settings: PlatformSettings = { ...DEFAULT_SETTINGS, promos: [] };

  raw.split(/\r?\n/).forEach((rawLine, index) => {
    const line = index + 1;
    const text = rawLine.trim();
    if (!text || text.startsWith('#') || text.startsWith('//')) return;

    const eq = text.indexOf('=');
    if (eq === -1) {
      issues.push({ line, message: `Expected "key = value", got "${text}".` });
      return;
    }

    const key = text.slice(0, eq).trim().toLowerCase();
    const value = text.slice(eq + 1).trim();

    if (key === 'promo' || key === 'promo_code') {
      const promo = parsePromoLine(value, line, issues);
      if (promo) settings.promos.push(promo);
      return;
    }

    if (!NUMERIC_KEY_SET.has(key)) {
      issues.push({
        line,
        message: `Unknown setting "${key}". Allowed: ${SETTINGS_NUMERIC_KEYS.join(', ')}, promo.`,
      });
      return;
    }

    const num = Number(value.replace(/[%$\s]/g, ''));
    if (!Number.isFinite(num)) {
      issues.push({ line, message: `${key} must be a number, got "${value}".` });
      return;
    }
    settings[key as SettingsNumericKey] = num;
  });

  validateShape(settings, issues, warnings);
  if (issues.length) invalid(issues);

  return { settings, warnings };
}

function normalizePromo(input: Partial<Promo>): Promo {
  return {
    code: String(input.code ?? '').toUpperCase(),
    kind: input.kind === 'fixed' ? 'fixed' : 'percent',
    value: Number(input.value ?? 0),
    plans: input.plans === 'all' || input.plans === undefined ? 'all' : input.plans,
    expires_at: input.expires_at ?? null,
    max_uses: Number(input.max_uses ?? 0),
    max_per_user: Number(input.max_per_user ?? 0),
    active: input.active !== false,
    ...(input.note ? { note: input.note } : {}),
  };
}

/** One canonical `promo = ...` line. */
export function promoLine(promo: Promo): string {
  const value = promo.kind === 'percent' ? `${promo.value}%` : `$${promo.value}`;
  const plans = promo.plans === 'all' ? 'all' : promo.plans.join(',');
  return `promo = ${promo.code} | ${value} | plans:${plans} | expires:${
    promo.expires_at ?? 'never'
  } | max_uses:${promo.max_uses} | max_per_user:${promo.max_per_user} | ${
    promo.active ? 'active' : 'inactive'
  }${promo.note ? ` | note:${promo.note}` : ''}`;
}

/** Canonical line-format text for a settings object. */
export function serializeSettings(settings: PlatformSettings): string {
  const lines = [
    '# SOGDIA platform settings',
    '# Prices live in src/config/pricing.ts and are NOT editable here.',
    '',
    ...SETTINGS_NUMERIC_KEYS.map((key) => `${key.padEnd(23)} = ${settings[key]}`),
    '',
    ...settings.promos.map(promoLine),
  ];

  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------
// Line surgery — add / edit / remove a single promo without rewriting
// the document. Comments, ordering and spacing the operator wrote are
// preserved; only the one line changes.
// ---------------------------------------------------------------------
const PROMO_LINE_RE = /^(\s*)promo(?:_code)?\s*=\s*(.+)$/i;

function isJsonDocument(raw: string): boolean {
  return raw.trim().startsWith('{');
}

function promoLineIndex(lines: string[], code: string): number {
  const wanted = code.trim().toUpperCase();
  return lines.findIndex((line) => {
    const match = line.match(PROMO_LINE_RE);
    if (!match) return false;
    const lineCode = match[2].split('|')[0]?.trim().toUpperCase();
    return lineCode === wanted;
  });
}

export function rawHasPromo(raw: string, code: string): boolean {
  if (isJsonDocument(raw)) {
    return parseSettings(raw).settings.promos.some(
      (p) => p.code === code.trim().toUpperCase(),
    );
  }
  return promoLineIndex(raw.split(/\r?\n/), code) !== -1;
}

/**
 * Rewrite the document with one promo added, replaced or removed.
 * A JSON document is normalised to the line format (JSON carries no
 * comments, so nothing is lost).
 */
export function applyPromoEdit(
  raw: string,
  code: string,
  promo: Promo | null,
): string {
  if (isJsonDocument(raw)) {
    const { settings } = parseSettings(raw);
    const wanted = code.trim().toUpperCase();
    const rest = settings.promos.filter((p) => p.code !== wanted);
    return serializeSettings({
      ...settings,
      promos: promo ? [...rest, promo] : rest,
    });
  }

  const lines = raw.split(/\r?\n/);
  const index = promoLineIndex(lines, code);

  // Remove
  if (!promo) {
    if (index === -1) return raw;
    lines.splice(index, 1);
    return lines.join('\n');
  }

  // Replace in place, keeping the original indentation
  if (index !== -1) {
    const indent = lines[index].match(PROMO_LINE_RE)?.[1] ?? '';
    lines[index] = `${indent}${promoLine(promo)}`;
    return lines.join('\n');
  }

  // Append after the last existing promo line, else at the end
  const lastPromo = lines.reduce(
    (last, line, i) => (PROMO_LINE_RE.test(line) ? i : last),
    -1,
  );

  if (lastPromo !== -1) {
    lines.splice(lastPromo + 1, 0, promoLine(promo));
    return lines.join('\n');
  }

  const trimmedEnd = [...lines];
  while (trimmedEnd.length && trimmedEnd[trimmedEnd.length - 1].trim() === '') {
    trimmedEnd.pop();
  }
  trimmedEnd.push('', promoLine(promo), '');
  return trimmedEnd.join('\n');
}

/** Merge a partial update onto an existing promo. */
export function mergePromo(current: Promo, patch: Partial<Promo>): Promo {
  return {
    ...current,
    ...patch,
    code: current.code,
    plans: patch.plans ?? current.plans,
    expires_at: patch.expires_at === undefined ? current.expires_at : patch.expires_at,
    note: patch.note === undefined ? current.note : patch.note,
  };
}

// ---------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------
export interface StoredSettings {
  settings: PlatformSettings;
  raw: string;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
}

const CACHE_TTL_MS = 15_000;
let cache: { value: StoredSettings; at: number } | null = null;

export function invalidateSettingsCache(): void {
  cache = null;
}

/** Live settings, with the shipped defaults as a fallback. Never throws. */
export async function getSettings(): Promise<StoredSettings> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const fallback: StoredSettings = {
    settings: DEFAULT_SETTINGS,
    raw: DEFAULT_SETTINGS_RAW,
    version: 0,
    updated_at: null,
    updated_by: null,
  };

  const { data, error } = await supabaseAdmin()
    .from('platform_settings')
    .select('raw, parsed, version, updated_at, updated_by')
    .eq('id', 'global')
    .maybeSingle<{
      raw: string;
      parsed: PlatformSettings;
      version: number;
      updated_at: string;
      updated_by: string | null;
    }>();

  if (error || !data) {
    // First boot (or a transient read failure): seed and serve defaults.
    if (!error) {
      await supabaseAdmin()
        .from('platform_settings')
        .upsert({
          id: 'global',
          raw: DEFAULT_SETTINGS_RAW,
          parsed: DEFAULT_SETTINGS,
          version: 1,
        });
    }
    cache = { value: fallback, at: Date.now() };
    return fallback;
  }

  // `parsed` is written on save; re-parse `raw` if it is missing or stale.
  let settings = data.parsed;
  if (!settings || typeof settings !== 'object' || !Array.isArray(settings.promos)) {
    try {
      settings = parseSettings(data.raw).settings;
    } catch {
      settings = DEFAULT_SETTINGS;
    }
  }

  const value: StoredSettings = {
    settings,
    raw: data.raw,
    version: data.version,
    updated_at: data.updated_at,
    updated_by: data.updated_by,
  };
  cache = { value, at: Date.now() };
  return value;
}

export async function saveSettings(
  raw: string,
  actorId: string,
): Promise<StoredSettings & { warnings: ParseIssue[] }> {
  const { settings, warnings } = parseSettings(raw);
  const current = await getSettings();

  const { data, error } = await supabaseAdmin()
    .from('platform_settings')
    .upsert({
      id: 'global',
      raw,
      parsed: settings,
      version: current.version + 1,
      updated_by: actorId,
      updated_at: new Date().toISOString(),
    })
    .select('raw, parsed, version, updated_at, updated_by')
    .single<{
      raw: string;
      parsed: PlatformSettings;
      version: number;
      updated_at: string;
      updated_by: string | null;
    }>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  invalidateSettingsCache();

  return {
    settings: data.parsed,
    raw: data.raw,
    version: data.version,
    updated_at: data.updated_at,
    updated_by: data.updated_by,
    warnings,
  };
}
