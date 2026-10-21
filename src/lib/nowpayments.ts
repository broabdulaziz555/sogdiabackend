import crypto from 'node:crypto';
import { ApiError, requireEnv } from '@/lib/http';

const API_URL = process.env.NOWPAYMENTS_API_URL ?? 'https://api.nowpayments.io/v1';

export interface CreateInvoiceInput {
  amount: number;
  order_id: string;
  order_description: string;
  pay_currency?: string;
  success_url?: string;
  cancel_url?: string;
  ipn_callback_url: string;
}

export interface NowPaymentsInvoice {
  id: string;
  invoice_url: string;
  order_id: string;
  price_amount: string | number;
  price_currency: string;
}

export async function createInvoice(input: CreateInvoiceInput): Promise<NowPaymentsInvoice> {
  const apiKey = requireEnv('NOWPAYMENTS_API_KEY');

  let res: Response;
  try {
    res = await fetch(`${API_URL}/invoice`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        price_amount: input.amount,
        price_currency: 'usd',
        order_id: input.order_id,
        order_description: input.order_description,
        ipn_callback_url: input.ipn_callback_url,
        success_url: input.success_url,
        cancel_url: input.cancel_url,
        ...(input.pay_currency ? { pay_currency: input.pay_currency } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ApiError('UPSTREAM_ERROR', 'Could not reach the payment provider.');
  }

  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !json?.invoice_url) {
    throw new ApiError('UPSTREAM_ERROR', 'Payment provider rejected the invoice.', json);
  }
  return json as unknown as NowPaymentsInvoice;
}

/**
 * NOWPayments signs the IPN body with HMAC-SHA512 over the JSON
 * serialisation of the payload with keys sorted alphabetically.
 */
export function verifyIpnSignature(rawBody: string, signature: string | null): boolean {
  if (!signature) return false;
  const secret = requireEnv('NOWPAYMENTS_IPN_SECRET');

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return false;
  }

  const sorted = JSON.stringify(sortKeys(parsed));
  const expected = crypto.createHmac('sha512', secret).update(sorted).digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeys((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

export type NowPaymentsStatus =
  | 'waiting'
  | 'confirming'
  | 'confirmed'
  | 'sending'
  | 'partially_paid'
  | 'finished'
  | 'failed'
  | 'refunded'
  | 'expired';

export function isPaid(status: string): boolean {
  return status === 'finished' || status === 'confirmed';
}

export function isDead(status: string): boolean {
  return status === 'failed' || status === 'refunded' || status === 'expired';
}

export function newOrderId(): string {
  return `SOGDIA-${crypto.randomBytes(4).toString('hex')}`;
}
