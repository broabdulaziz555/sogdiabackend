import { ApiError, handle, ok } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { rateLimit } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

const BUCKET = 'kyc-documents';
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const SIGNED_URL_TTL = 3600;

/**
 * POST /api/kyc/upload   (multipart/form-data: file, doc_type?)
 * Stores the document in a private bucket under <user_id>/ and flips
 * the user's KYC status to `pending` for admin review.
 */
export const POST = handle(async (req) => {
  const user = await requireUser(req);
  rateLimit(`kyc:${user.id}`, 5, 60 * 60_000);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new ApiError('VALIDATION_ERROR', 'Expected multipart/form-data.');
  }

  const file = form.get('file');
  const docType = String(form.get('doc_type') ?? 'id_document');

  if (!(file instanceof File)) {
    throw new ApiError('VALIDATION_ERROR', 'Field "file" is required.');
  }
  if (!ALLOWED.includes(file.type)) {
    throw new ApiError('VALIDATION_ERROR', 'File must be JPG, PNG, WEBP or PDF.');
  }
  if (file.size > MAX_BYTES) {
    throw new ApiError('VALIDATION_ERROR', 'File must be 5 MB or smaller.');
  }

  const ext = file.name.includes('.') ? file.name.split('.').pop() : 'bin';
  const path = `${user.id}/${docType}-${Date.now()}.${ext}`;
  const admin = supabaseAdmin();

  const { error: uploadError } = await admin.storage
    .from(BUCKET)
    .upload(path, await file.arrayBuffer(), { contentType: file.type, upsert: false });

  if (uploadError) throw new ApiError('INTERNAL_ERROR', uploadError.message);

  const { data: signed } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL);

  await admin
    .from('users')
    .update({ kyc_status: 'pending', kyc_document_url: path, kyc_note: null })
    .eq('id', user.id);

  return ok({
    path,
    signed_url: signed?.signedUrl ?? null,
    expires_in: SIGNED_URL_TTL,
    kyc_status: 'pending',
  });
});
