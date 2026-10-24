import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireXDepartment } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { provisionAccount, serializeAccount } from '@/lib/accounts';
import { getPlan } from '@/config/pricing';
import { audit } from '@/lib/audit';
import { notify } from '@/lib/notifications';
import { giftAccountSchema } from '@/lib/validation';
import type { DbAccount, DbUser } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/xdepartment/accounts/gift
 *
 * Provision one or more accounts to any user, free of charge — test
 * accounts, comped accounts, influencer accounts, competition prizes,
 * goodwill replacements. Any plan, or a fully custom size and rule-set.
 * Pricing is never touched: nothing here writes to the price table.
 */
export const POST = handle(async (req) => {
  const staff = await requireXDepartment(req);
  const body = giftAccountSchema.parse(await readJson(req));
  const admin = supabaseAdmin();

  // Resolve the recipient by id or email.
  let recipient: DbUser | null = null;
  if (body.user_id) {
    const { data } = await admin.from('users').select('*').eq('id', body.user_id).maybeSingle<DbUser>();
    recipient = data;
  } else if (body.email) {
    const { data } = await admin
      .from('users')
      .select('*')
      .ilike('email', body.email.replace(/[\\%_]/g, '\\$&')) // exact, case-insensitive: _ and % are not wildcards here
      .maybeSingle<DbUser>();
    recipient = data;
  }
  if (!recipient) throw new ApiError('NOT_FOUND', 'Recipient not found.');

  // Plan-based or fully custom.
  const plan = body.plan_key ? getPlan(body.plan_key) : null;
  if (body.plan_key && !plan) throw new ApiError('VALIDATION_ERROR', 'Unknown plan_key.');

  const spec = plan
    ? { type: plan.type, size: plan.size, plan_key: plan.key }
    : { type: body.custom!.type, size: body.custom!.size, plan_key: null };

  const created: DbAccount[] = [];
  for (let i = 0; i < body.quantity; i += 1) {
    const account = await provisionAccount(recipient.id, {
      ...spec,
      is_gifted: true,
      rules: body.rules,
    });
    created.push(account);

    // A zero-cost transaction keeps the ledger complete and auditable.
    await admin.from('transactions').insert({
      user_id: recipient.id,
      account_id: account.id,
      amount: 0,
      type: 'adjustment',
      status: 'paid',
      admin_note: body.reason ?? 'X-Department gifted account',
      metadata: {
        gifted: true,
        granted_by: staff.id,
        plan_key: spec.plan_key,
        size: spec.size,
        rules: body.rules ?? null,
      },
    });

    await audit(
      staff,
      'account.gift',
      { type: 'account', id: account.id },
      {
        recipient: recipient.id,
        recipient_email: recipient.email,
        plan_key: spec.plan_key,
        size: spec.size,
        rules: body.rules ?? null,
        reason: body.reason ?? null,
      },
      req,
    );
  }

  const label = plan?.label ?? `${spec.type === 'one_step' ? 'One-Step' : 'Instant'} $${spec.size.toLocaleString()}`;
  await notify(
    recipient.id,
    'account_gifted',
    body.quantity > 1 ? `${body.quantity} accounts added` : `${label} account added`,
    body.reason ?? `SOGDIA has credited you with a ${label} account. It is live and ready to trade.`,
    { account_ids: created.map((a) => a.id) },
  );

  return ok({
    granted: created.length,
    recipient: { id: recipient.id, email: recipient.email },
    accounts: created.map(serializeAccount),
  });
});
