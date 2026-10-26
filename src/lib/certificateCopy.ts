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
    caption: 'has successfully passed the SOGDIA evaluation and earned a funded account',
    amountLabel: 'ACCOUNT SIZE',
  },
  phase1_pass: {
    label: 'Phase 1 passed',
    title: 'PHASE 1 COMPLETED',
    caption: 'has successfully passed Phase 1 of the SOGDIA evaluation',
    amountLabel: 'ACCOUNT SIZE',
  },
  phase2_pass: {
    label: 'Phase 2 passed',
    title: 'PHASE 2 COMPLETED',
    caption: 'has successfully passed Phase 2 of the SOGDIA evaluation',
    amountLabel: 'ACCOUNT SIZE',
  },
  funded: {
    label: 'Funded trader',
    title: 'FUNDED TRADER CERTIFICATE',
    caption: 'has been granted a SOGDIA funded trading account',
    amountLabel: 'ACCOUNT SIZE',
  },
  payout: {
    label: 'Payout',
    title: 'CERTIFICATE OF PAYOUT',
    caption: 'has successfully withdrawn profits from a SOGDIA funded account',
    amountLabel: 'AMOUNT PAID',
  },
  achievement: {
    label: 'Achievement',
    title: 'CERTIFICATE OF EXCELLENCE',
    caption: 'has been recognised for outstanding trading performance at SOGDIA',
    amountLabel: 'PROFIT',
  },
  custom: {
    label: 'Custom',
    title: 'CERTIFICATE',
    caption: 'is recognised by SOGDIA',
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
