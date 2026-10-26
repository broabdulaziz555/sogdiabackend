import type { CertificateType } from '@/lib/types';

/**
 * Default wording per certificate type. The certificate image falls back to these; a manual certificate can override
 * title / caption / amount label through its metadata. Mirrored in the frontend builder for the live preview — keep
 * the two in sync.
 */
export const CERTIFICATE_TYPES = ['eval_pass', 'phase1_pass', 'phase2_pass', 'funded', 'payout', 'achievement', 'custom'] as const;

export const CERTIFICATE_COPY: Record<CertificateType, { label: string; title: string; caption: string; amountLabel: string }> = {
  eval_pass: {
    label: 'Evaluation passed',
    title: 'CERTIFICATE OF ACHIEVEMENT',
    caption: 'has successfully completed the SOGDIA Evaluation and qualified for a funded trading account',
    amountLabel: 'ACCOUNT SIZE',
  },
  phase1_pass: {
    label: 'Phase 1 passed',
    title: 'PHASE ONE COMPLETION',
    caption: 'has successfully completed Phase One of the SOGDIA Evaluation',
    amountLabel: 'ACCOUNT SIZE',
  },
  phase2_pass: {
    label: 'Phase 2 passed',
    title: 'PHASE TWO COMPLETION',
    caption: 'has successfully completed Phase Two of the SOGDIA Evaluation',
    amountLabel: 'ACCOUNT SIZE',
  },
  funded: {
    label: 'Funded trader',
    title: 'FUNDED TRADER CERTIFICATE',
    caption: 'has qualified as a SOGDIA Funded Trader and been granted a funded trading account',
    amountLabel: 'ACCOUNT SIZE',
  },
  payout: {
    label: 'Payout',
    title: 'CERTIFICATE OF PAYOUT',
    caption: 'has received a profit distribution from a SOGDIA funded trading account',
    amountLabel: 'AMOUNT PAID',
  },
  achievement: {
    label: 'Achievement',
    title: 'CERTIFICATE OF EXCELLENCE',
    caption: 'is recognised for outstanding trading performance and disciplined risk management',
    amountLabel: 'PROFIT',
  },
  custom: {
    label: 'Custom',
    title: 'CERTIFICATE',
    caption: 'is recognised by SOGDIA Capital',
    amountLabel: 'AMOUNT',
  },
};

export interface CertificateOverrides {
  title?: string;
  caption?: string;
  amount_label?: string;
  hide_amount?: boolean;
}

/** Resolve the text a certificate is drawn with: metadata overrides first, then the type's defaults. */
export function resolveCertificateCopy(type: string, metadata: Record<string, unknown> | null | undefined) {
  const base = CERTIFICATE_COPY[type as CertificateType] ?? CERTIFICATE_COPY.custom;
  const m = (metadata ?? {}) as CertificateOverrides;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    label: base.label,
    title: (str(m.title) ?? base.title).toUpperCase(),
    caption: str(m.caption) ?? base.caption,
    amountLabel: (str(m.amount_label) ?? base.amountLabel).toUpperCase(),
    hideAmount: m.hide_amount === true,
  };
}

/** The two values the database enum has always had. Other types are stored as one of these + `metadata.kind`. */
const DB_TYPES = new Set(['eval_pass', 'payout']);

/** Column value + metadata to store for a certificate type, so new types need no database migration. */
export function storageType(type: CertificateType): { dbType: 'eval_pass' | 'payout'; kind: CertificateType | null } {
  if (DB_TYPES.has(type)) return { dbType: type as 'eval_pass' | 'payout', kind: null };
  return { dbType: 'eval_pass', kind: type };
}

/** The certificate's real type: `metadata.kind` when set, else the column value. */
export function effectiveType(c: { type: string; metadata?: Record<string, unknown> | null }): string {
  const k = c.metadata?.kind;
  return typeof k === 'string' && k in CERTIFICATE_COPY ? k : c.type;
}
