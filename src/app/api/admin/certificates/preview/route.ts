import { ImageResponse } from 'next/og';
import { handle, ok, readJson } from '@/lib/http';
import { requireStaff } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { storageType } from '@/lib/certificateCopy';
import { certificateElement, type CertificateRow } from '@/lib/certificateImage';
import { certificatePreviewSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/admin/certificates/preview — renders the certificate exactly as it will be issued (same artwork as
 * /api/og/certificate/{id}) without saving anything. Returns { image: "data:image/png;base64,…" }.
 */
export const POST = handle(async (req) => {
  await requireStaff(req);
  const body = certificatePreviewSchema.parse(await readJson(req));

  let accounts: CertificateRow['accounts'] = null;
  if (body.account_id) {
    const { data } = await supabaseAdmin().from('accounts').select('size, type, plan_key').eq('id', body.account_id).maybeSingle();
    if (data) accounts = { size: Number(data.size), type: data.type, plan_key: data.plan_key };
  }

  const { dbType, kind } = storageType(body.type);
  const row = {
    id: 'preview', user_id: 'preview', account_id: body.account_id ?? null,
    type: dbType, amount: body.amount ?? 0, code: 'PREVIEW',
    display_name: body.display_name?.trim() || 'SOGDIA Trader', is_manual: true, issued_by: null,
    issued_at: body.issued_at ?? new Date().toISOString(),
    metadata: {
      ...(kind ? { kind } : {}),
      ...(body.title ? { title: body.title } : {}),
      ...(body.caption ? { caption: body.caption } : {}),
      ...(body.amount_label ? { amount_label: body.amount_label } : {}),
      ...(body.hide_amount ? { hide_amount: true } : {}),
    },
    accounts,
  } as unknown as CertificateRow;

  const png = Buffer.from(await new ImageResponse(certificateElement(row), { width: 1200, height: 850 }).arrayBuffer());
  return ok({ image: `data:image/png;base64,${png.toString('base64')}` });
});
