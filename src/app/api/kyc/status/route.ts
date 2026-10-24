import { handle, ok } from '@/lib/http';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** GET /api/kyc/status */
export const GET = handle(async (req) => {
  const user = await requireUser(req);
  return ok({
    kyc_status: user.kyc_status,
    document_url: user.kyc_document_url,
    note: user.kyc_note,
  });
});
