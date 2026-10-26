import { ApiError } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase';
import type { CertificateType, DbCertificate } from '@/lib/types';
import { storageType } from '@/lib/certificateCopy';

export interface IssueCertificateInput {
  user_id: string;
  account_id?: string | null;
  type: CertificateType;
  amount: number;
  display_name?: string | null;
  is_manual?: boolean;
  issued_by?: string | null;
  metadata?: Record<string, unknown>;
  /** Backdate a manual certificate; defaults to now. */
  issued_at?: string | null;
}

export async function issueCertificate(input: IssueCertificateInput): Promise<DbCertificate> {
  const admin = supabaseAdmin();

  let displayName = input.display_name ?? null;
  if (!displayName) {
    const { data: user } = await admin
      .from('users')
      .select('full_name, email')
      .eq('id', input.user_id)
      .maybeSingle<{ full_name: string | null; email: string }>();
    displayName = user?.full_name ?? user?.email?.split('@')[0] ?? 'SOGDIA Trader';
  }

  const { dbType, kind } = storageType(input.type);
  const { data, error } = await admin
    .from('certificates')
    .insert({
      user_id: input.user_id,
      account_id: input.account_id ?? null,
      type: dbType,
      amount: input.amount,
      display_name: displayName,
      is_manual: input.is_manual ?? false,
      issued_by: input.issued_by ?? null,
      metadata: { ...(input.metadata ?? {}), ...(kind ? { kind } : {}) },
      ...(input.issued_at ? { issued_at: input.issued_at } : {}),
    })
    .select('*')
    .single<DbCertificate>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  return { ...data, type: input.type };
}

export function certificateImageUrl(id: string): string {
  return `/api/og/certificate/${id}`;
}
