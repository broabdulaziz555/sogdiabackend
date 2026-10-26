import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireStaff } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { certificateImageUrl, issueCertificate } from '@/lib/certificates';
import { audit } from '@/lib/audit';
import { effectiveType, resolveCertificateCopy } from '@/lib/certificateCopy';
import { notify } from '@/lib/notifications';
import { adminCertificateSchema, paginationSchema } from '@/lib/validation';
import type { DbCertificate } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** GET /api/admin/certificates?user_id=&type=&limit=&offset= */
export const GET = handle(async (req) => {
  await requireStaff(req);
  const url = new URL(req.url);
  const { limit, offset } = paginationSchema.parse({
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  });

  let query = supabaseAdmin()
    .from('certificates')
    // two links to users (user_id = recipient, issued_by = staff): embed the recipient explicitly
    .select('*, users!user_id(email, full_name)', { count: 'exact' })
    .order('issued_at', { ascending: false })
    .range(offset, offset + limit - 1);

  const userId = url.searchParams.get('user_id');
  const type = url.searchParams.get('type');
  if (userId) query = query.eq('user_id', userId);
  if (type === 'eval_pass' || type === 'payout') query = query.eq('type', type).is('metadata->kind', null);
  else if (type) query = query.eq('metadata->>kind', type);

  const { data, error, count } = await query;
  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  const rows = (data ?? []) as Array<DbCertificate & { users: { email: string } | null }>;

  return ok({
    certificates: rows.map(({ users, ...c }) => ({
      ...c,
      type: effectiveType(c),
      amount: Number(c.amount),
      user_email: users?.email ?? null,
      image_url: certificateImageUrl(c.id),
    })),
    total: count ?? rows.length,
    limit,
    offset,
  });
});

/** POST /api/admin/certificates — manual issuance. */
export const POST = handle(async (req) => {
  const staff = await requireStaff(req);
  const body = adminCertificateSchema.parse(await readJson(req));

  const certificate = await issueCertificate({
    user_id: body.user_id,
    account_id: body.account_id ?? null,
    type: body.type,
    amount: body.amount,
    display_name: body.display_name,
    is_manual: true,
    issued_by: staff.id,
    issued_at: body.issued_at ?? null,
    metadata: {
      issued_via: 'admin_panel',
      ...(body.title ? { title: body.title } : {}),
      ...(body.caption ? { caption: body.caption } : {}),
      ...(body.amount_label ? { amount_label: body.amount_label } : {}),
      ...(body.hide_amount ? { hide_amount: true } : {}),
    },
  });

  await audit(
    staff,
    'certificate.manual',
    { type: 'certificate', id: certificate.id },
    { user_id: body.user_id, type: body.type, amount: body.amount, title: body.title ?? null, issued_at: body.issued_at ?? null },
    req,
  );

  if (body.notify !== false) {
    const label = resolveCertificateCopy(body.type, certificate.metadata).label.toLowerCase();
    await notify(
      body.user_id,
      'certificate_issued',
      'New certificate issued',
      `A ${label} certificate has been added to your profile.`,
      { certificate_id: certificate.id },
    );
  }

  return ok({
    certificate: { ...certificate, amount: Number(certificate.amount) },
    image_url: certificateImageUrl(certificate.id),
  });
});
