import { supabaseAdmin } from '@/lib/supabase';

export type NotificationType =
  | 'account_created'
  | 'account_failed'
  | 'account_passed'
  | 'position_liquidated'
  | 'payout_requested'
  | 'payout_paid'
  | 'payout_rejected'
  | 'kyc_verified'
  | 'kyc_rejected'
  | 'certificate_issued'
  | 'account_gifted'
  | 'admin_action';

export async function notify(
  userId: string,
  type: NotificationType,
  title: string,
  body: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('notifications')
    .insert({ user_id: userId, type, title, body, metadata });

  if (error) console.error('[notifications] insert failed', error.message);
}
