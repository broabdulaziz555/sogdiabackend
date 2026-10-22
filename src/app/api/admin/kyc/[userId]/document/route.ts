import { ApiError, handle, ok } from '@/lib/http';
import { requireStaff } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const BUCKET = 'kyc-documents';
const SIGNED_URL_TTL = 3600; // 1 h; the admin screen requests a fresh link every time a submission is opened and renews it before it lapses

/**
 * GET /api/admin/kyc/{userId}/document
 * The bucket is private and `users.kyc_document_url` stores only the object path, so staff need a
 * short-lived signed URL to open the submitted document.
 */
export const GET = handle(async (req: Request, ctx: { params: { userId: string } }) => {
  await requireStaff(req);
  const admin = supabaseAdmin();

  const { data, error } = await admin
    .from('users')
    .select('kyc_document_url')
    .eq('id', ctx.params.userId)
    .maybeSingle<{ kyc_document_url: string | null }>();
  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  if (!data) throw new ApiError('NOT_FOUND', 'User not found.');

  const stored = data.kyc_document_url;
  if (!stored) throw new ApiError('NOT_FOUND', 'This user has not uploaded a document.');

  // already a full URL (legacy rows) — hand it back untouched
  if (/^https?:\/\//i.test(stored)) {
    return ok({ url: stored, path: stored, expires_in: null, kind: /\.pdf(\?|$)/i.test(stored) ? 'pdf' : 'image' });
  }

  // tolerate a leading "<bucket>/" in the stored value
  const path = stored.replace(new RegExp(`^/?${BUCKET}/`), '').replace(/^\/+/, '');
  const { data: signed, error: signError } = await admin.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL);
  if (signError || !signed?.signedUrl) {
    throw new ApiError('NOT_FOUND', 'The stored document could not be found in storage.');
  }

  return ok({
    url: signed.signedUrl,
    path,
    expires_in: SIGNED_URL_TTL,
    kind: /\.pdf$/i.test(path) ? 'pdf' : 'image',
  });
});
