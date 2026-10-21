import { ApiError, handle, ok, readJson, requireEnv } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { createInvoice, newOrderId } from '@/lib/nowpayments';
import { getPlan } from '@/config/pricing';
import { quoteCheckout } from '@/lib/promos';
import { checkoutSchema } from '@/lib/validation';
import { withIdempotency } from '@/lib/idempotency';
import { rateLimit } from '@/lib/ratelimit';
import type { DbTransaction } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/checkout
 * Creates a pending purchase + a NOWPayments invoice.
 * The account itself is only created by the IPN once funds confirm.
 */
export const POST = handle(async (req) => {
  const user = await requireUser(req);
  rateLimit(`checkout:${user.id}`, 10, 60_000);

  const body = checkoutSchema.parse(await readJson(req));
  const plan = getPlan(body.plan_key);
  if (!plan) throw new ApiError('VALIDATION_ERROR', 'Unknown plan.');

  return withIdempotency(req, user.id, 'checkout', async () => {
    const orderId = newOrderId();
    const appUrl = requireEnv('NEXT_PUBLIC_APP_URL');

    // Discounts come from the X-Department settings blob. The plan's list
    // price is never modified — only what we invoice.
    const quote = await quoteCheckout(plan, user, body.promo_code);

    const { data: tx, error } = await supabaseAdmin()
      .from('transactions')
      .insert({
        user_id: user.id,
        amount: quote.final_price,
        currency: 'USD',
        type: 'purchase',
        status: 'pending',
        nowpayments_order_id: orderId,
        metadata: {
          plan_key: plan.key,
          account_type: plan.type,
          size: plan.size,
          pay_currency: body.pay_currency ?? null,
          list_price: quote.list_price,
          discount: quote.discount,
          discount_source: quote.source,
          promo_code: quote.promo_code,
        },
      })
      .select('*')
      .single<DbTransaction>();

    if (error) throw new ApiError('INTERNAL_ERROR', error.message);

    const invoice = await createInvoice({
      amount: quote.final_price,
      order_id: orderId,
      order_description: `SOGDIA ${plan.label}`,
      pay_currency: body.pay_currency,
      ipn_callback_url: `${appUrl}/api/webhook/nowpayments`,
      success_url: `${appUrl}/checkout/success?order=${orderId}`,
      cancel_url: `${appUrl}/checkout/cancelled?order=${orderId}`,
    });

    await supabaseAdmin()
      .from('transactions')
      .update({
        metadata: { ...(tx.metadata as object), invoice_id: invoice.id, invoice_url: invoice.invoice_url },
      })
      .eq('id', tx.id);

    return {
      transaction_id: tx.id,
      order_id: orderId,
      invoice_url: invoice.invoice_url,
      amount: quote.final_price,
      pricing: {
        list_price: quote.list_price,
        discount: quote.discount,
        final_price: quote.final_price,
        source: quote.source,
        promo_code: quote.promo_code,
        label: quote.label,
      },
      plan: { key: plan.key, label: plan.label, size: plan.size, price: plan.price },
    };
  }).then(ok);
});
