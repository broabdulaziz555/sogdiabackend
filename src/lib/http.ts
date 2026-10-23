import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'ACCOUNT_NOT_TRADABLE'
  | 'ORDER_NOT_OPEN'
  | 'INSUFFICIENT_MARGIN'
  | 'SYMBOL_NOT_ALLOWED'
  | 'KYC_REQUIRED'
  | 'PAYOUT_NOT_ELIGIBLE'
  | 'DUPLICATE'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'FEATURE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  ACCOUNT_NOT_TRADABLE: 409,
  ORDER_NOT_OPEN: 409,
  INSUFFICIENT_MARGIN: 409,
  SYMBOL_NOT_ALLOWED: 409,
  KYC_REQUIRED: 409,
  PAYOUT_NOT_ELIGIBLE: 409,
  DUPLICATE: 409,
  RATE_LIMITED: 429,
  UPSTREAM_ERROR: 502,
  FEATURE_UNAVAILABLE: 501,
  INTERNAL_ERROR: 500,
};

/** Throw this anywhere inside a handler wrapped by `handle()`. */
export class ApiError extends Error {
  code: ErrorCode;
  details: unknown;

  constructor(code: ErrorCode, message: string, details: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }
}

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, { status: 200, ...init });
}

export function fail(code: ErrorCode, message: string, details: unknown = null) {
  return NextResponse.json(
    { ok: false, error: { code, message, details } },
    { status: STATUS_BY_CODE[code] },
  );
}

/**
 * Wraps a route handler so every throw becomes a well-formed error envelope.
 *
 *   export const POST = handle(async (req) => { ... return ok(data); });
 */
export function handle<Ctx = unknown>(
  fn: (req: Request, ctx: Ctx) => Promise<Response>,
) {
  return async (req: Request, ctx: Ctx): Promise<Response> => {
    const t0 = Date.now();
    const path = (() => { try { return new URL(req.url).pathname; } catch { return '?'; } })();
    try {
      const res = await fn(req, ctx);
      const ms = Date.now() - t0;
      if (ms > 2000) console.warn(`[api] slow ${ms}ms ${req.method} ${path}`);
      return res;
    } catch (err) {
      console.warn(`[api] ${req.method} ${path} failed after ${Date.now() - t0}ms:`, err instanceof ApiError ? `${err.code} ${err.message}` : err);
      if (err instanceof ApiError) {
        return fail(err.code, err.message, err.details);
      }
      if (err instanceof ZodError) {
        return fail('VALIDATION_ERROR', 'Request payload is invalid.', err.flatten());
      }
      console.error('[api] unhandled error', err);
      return fail('INTERNAL_ERROR', 'Something went wrong.');
    }
  };
}

/** Parse a JSON body, failing cleanly on malformed input. */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ApiError('VALIDATION_ERROR', 'Body must be valid JSON.');
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ApiError('INTERNAL_ERROR', `Missing environment variable: ${name}`);
  }
  return value;
}
