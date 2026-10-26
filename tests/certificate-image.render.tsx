// Renders every certificate type to PNG with the real artwork code: `npx tsx tests/certificate-image.render.tsx <outdir>`
import { writeFileSync } from 'node:fs';
import { ImageResponse } from 'next/og';
import { certificateElement, type CertificateRow } from '../src/lib/certificateImage';
import { CERTIFICATE_TYPES } from '../src/lib/certificateCopy';

const out = process.argv[2] ?? '.';
const base = {
  id: '00000000-0000-0000-0000-000000000000', user_id: 'u', account_id: null, amount: 2500, code: 'SG-TEST01',
  display_name: 'Ali Karimov', is_manual: true, issued_by: null, issued_at: '2026-10-26T12:00:00Z', accounts: null,
} as unknown as CertificateRow;

(async () => {
  let failed = 0;
  const cases: [string, Partial<CertificateRow>][] = [
    ...CERTIFICATE_TYPES.map((t) => [t, { type: t === 'payout' ? 'payout' : 'eval_pass', metadata: t === 'payout' || t === 'eval_pass' ? {} : { kind: t } }] as [string, Partial<CertificateRow>]),
    ['payout-with-account', { type: 'payout', metadata: {}, accounts: { size: 10000, type: 'evaluation', plan_key: 'x' } }],
    ['custom-hidden-amount', { type: 'eval_pass', metadata: { kind: 'custom', title: 'Trader of the month', caption: 'for exceptional discipline', hide_amount: true } }],
  ];
  for (const [name, patch] of cases) {
    try {
      const res = new ImageResponse(certificateElement({ ...base, ...patch } as CertificateRow), { width: 1200, height: 850 });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) throw new Error(`tiny output (${buf.length} bytes)`);
      writeFileSync(`${out}/${name}.png`, buf);
      console.log('ok  ', name, buf.length);
    } catch (e) { failed++; console.log('FAIL', name, e instanceof Error ? e.message : e); }
  }
  process.exit(failed ? 1 : 0);
})();
