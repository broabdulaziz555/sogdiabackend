import { ImageResponse } from 'next/og';
import { supabaseAdmin } from '@/lib/supabase';
import type { DbCertificate } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BRAND = '#00E08F';
const BG = '#070B10';

function fmtUsd(n: number) {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** GET /api/og/certificate/{id} -> image/png (1200x850) */
export async function GET(_req: Request, ctx: { params: { id: string } }) {
  const { data } = await supabaseAdmin()
    .from('certificates')
    .select('*, accounts(size, type, plan_key)')
    .eq('id', ctx.params.id)
    .maybeSingle<DbCertificate & { accounts: { size: number; type: string; plan_key: string | null } | null }>();

  if (!data) {
    return new ImageResponse(
      (
        <div style={{
          width: '100%', height: '100%', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          background: BG, color: '#9AA7B4', fontSize: 44,
        }}>
          Certificate not found
        </div>
      ),
      { width: 1200, height: 850 },
    );
  }

  const isPayout = data.type === 'payout';
  const title = isPayout ? 'CERTIFICATE OF PAYOUT' : 'CERTIFICATE OF ACHIEVEMENT';
  const caption = isPayout
    ? 'has successfully withdrawn profits from a SOGDIA funded account'
    : 'has successfully passed the SOGDIA evaluation and earned a funded account';

  const issued = new Date(data.issued_at).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
  const accountSize = data.accounts?.size ? Number(data.accounts.size) : null;

  return new ImageResponse(
    (
      <div style={{
        width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
        alignItems: 'center', background: BG, color: '#FFFFFF', padding: 56,
        fontFamily: 'ui-serif, Georgia, serif',
        backgroundImage: `radial-gradient(800px 500px at 50% -15%, ${BRAND}1A, transparent)`,
      }}>
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          width: '100%', height: '100%', border: `2px solid ${BRAND}55`,
          borderRadius: 24, padding: 56,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{
              width: 40, height: 40, borderRadius: 10, background: BRAND,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: BG, fontSize: 24, fontWeight: 800,
            }}>S</div>
            <div style={{ fontSize: 28, letterSpacing: 8, fontWeight: 700 }}>SOGDIA</div>
          </div>
          <div style={{
            display: 'flex', fontSize: 16, letterSpacing: 4, color: '#7D8B99', marginTop: 12,
            fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          }}>
            SOGDIA.SITE · INSTITUTIONAL CRYPTO PROP FIRM
          </div>

          <div style={{ fontSize: 26, letterSpacing: 6, color: BRAND, marginTop: 34 }}>{title}</div>
          <div style={{ fontSize: 20, color: '#7D8B99', marginTop: 10 }}>This certifies that</div>

          <div style={{
            fontSize: 72, fontWeight: 700, marginTop: 18,
            borderBottom: `1px solid ${BRAND}44`, paddingBottom: 18,
          }}>
            {data.display_name ?? 'SOGDIA Trader'}
          </div>

          <div style={{ fontSize: 24, color: '#9AA7B4', marginTop: 26, textAlign: 'center', maxWidth: 820 }}>
            {caption}
          </div>

          <div style={{ display: 'flex', gap: 80, marginTop: 44 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{ fontSize: 18, color: '#6E7D8C', letterSpacing: 2 }}>
                {isPayout ? 'AMOUNT PAID' : 'ACCOUNT SIZE'}
              </div>
              <div style={{ fontSize: 56, fontWeight: 700, color: BRAND, marginTop: 8 }}>
                {fmtUsd(Number(data.amount))}
              </div>
            </div>
            {accountSize !== null && isPayout && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ fontSize: 18, color: '#6E7D8C', letterSpacing: 2 }}>ACCOUNT</div>
                <div style={{ fontSize: 56, fontWeight: 700, marginTop: 8 }}>
                  ${(accountSize / 1000).toFixed(0)}K
                </div>
              </div>
            )}
          </div>

          <div style={{
            display: 'flex', justifyContent: 'space-between', width: '100%',
            marginTop: 'auto', fontSize: 20, color: '#6E7D8C',
            fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          }}>
            <div style={{ display: 'flex' }}>Issued {issued}</div>
            <div style={{ display: 'flex' }}>Verification code · {data.code}</div>
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 850,
      headers: { 'cache-control': 'public, max-age=600, s-maxage=86400' },
    },
  );
}
