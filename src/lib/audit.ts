import { supabaseAdmin } from '@/lib/supabase';
import { clientIp } from '@/lib/ratelimit';
import type { DbUser } from '@/lib/types';

export type AuditAction =
  | 'account.freeze'
  | 'account.unfreeze'
  | 'account.breach'
  | 'account.close'
  | 'account.gift'
  | 'account.adjust'
  | 'account.delete'
  | 'account.rules_override'
  | 'kyc.approve'
  | 'kyc.reject'
  | 'kyc.force'
  | 'payout.approve'
  | 'payout.reject'
  | 'payout.paid'
  | 'payout.force'
  | 'certificate.manual'
  | 'certificate.delete'
  | 'user.role_change'
  | 'user.impersonate'
  | 'settings.update'
  | 'promo.create'
  | 'promo.update'
  | 'promo.delete';

/**
 * Every privileged mutation is written here. Append-only by policy —
 * nothing in the API ever updates or deletes an audit row.
 */
export async function audit(
  actor: DbUser,
  action: AuditAction,
  target: {
    type: 'user' | 'account' | 'transaction' | 'certificate' | 'order' | 'settings' | 'promo';
    id: string;
  },
  payload: Record<string, unknown> = {},
  req?: Request,
): Promise<void> {
  // target_id is a uuid column; settings and promos are keyed by name,
  // which travels in the payload instead.
  const keyedByName = target.type === 'settings' || target.type === 'promo';
  const targetId = keyedByName ? null : target.id;
  const body = keyedByName ? { ...payload, target_key: target.id } : payload;

  const { error } = await supabaseAdmin().from('audit_logs').insert({
    actor_id: actor.id,
    actor_role: actor.role,
    action,
    target_type: target.type,
    target_id: targetId,
    payload: body,
    ip: req ? clientIp(req) : null,
  });

  if (error) console.error('[audit] insert failed', error.message);
}
