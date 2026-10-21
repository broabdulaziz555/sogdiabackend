import { ApiError } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase';

/**
 * Replays the stored response when the same Idempotency-Key is seen twice.
 * Without the header the handler simply runs normally.
 */
export async function withIdempotency<T>(
  req: Request,
  userId: string,
  route: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = req.headers.get('idempotency-key');
  if (!key) return fn();

  const admin = supabaseAdmin();

  const { data: existing } = await admin
    .from('idempotency_keys')
    .select('response')
    .eq('key', key)
    .eq('user_id', userId)
    .maybeSingle<{ response: T }>();

  if (existing) return existing.response;

  const result = await fn();

  const { error } = await admin
    .from('idempotency_keys')
    .insert({ key, user_id: userId, route, response: result });

  // A concurrent duplicate lost the race — replay the winner's response.
  if (error && error.code === '23505') {
    const { data: winner } = await admin
      .from('idempotency_keys')
      .select('response')
      .eq('key', key)
      .maybeSingle<{ response: T }>();
    if (winner) return winner.response;
    throw new ApiError('DUPLICATE', 'Duplicate request in flight.');
  }

  return result;
}
