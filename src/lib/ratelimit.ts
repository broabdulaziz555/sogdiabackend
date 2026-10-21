import { ApiError } from '@/lib/http';

/**
 * In-process sliding-window limiter. Good enough for a single Node
 * instance; swap the Map for Upstash Redis when you scale horizontally
 * (same signature, make it async).
 */
const buckets = new Map<string, number[]>();

export function rateLimit(key: string, max: number, windowMs: number): void {
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);

  if (hits.length >= max) {
    throw new ApiError(
      'RATE_LIMITED',
      `Too many requests — try again in ${Math.ceil((windowMs - (now - hits[0])) / 1000)}s.`,
    );
  }

  hits.push(now);
  buckets.set(key, hits);

  // Opportunistic cleanup so the map cannot grow without bound.
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) {
      if (v.every((t) => now - t >= windowMs)) buckets.delete(k);
    }
  }
}

export function clientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  );
}
