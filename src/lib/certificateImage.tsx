import type { DbCertificate } from '@/lib/types';
import { effectiveType, resolveCertificateCopy } from '@/lib/certificateCopy';
import { certificateFonts } from '@/lib/certificateFonts';

const BRAND = '#00E08F';
const BG = '#070B10';
const INK = '#F1F4F7';   // name
const TEXT = '#B4BEC9';  // body copy (light, not white)
const MUTED = '#7F8B98'; // labels
const SERIF = 'Cormorant, CormorantCyr'; // Satori only falls back across differently named fonts
const SANS = 'Inter, InterCyr';
const FIG = SANS; // money in lining figures (the serif's old-style numerals read oddly for amounts)

function fmtUsd(n: number) {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export type CertificateRow = DbCertificate & { accounts: { size: number; type: string; plan_key: string | null } | null };

/** ImageResponse options for the certificate: size and the embedded fonts. */
export function certificateImageOptions() {
  return { width: 1200, height: 850, fonts: certificateFonts() };
}

/** Small uppercase label above / below a value. */
const Label = ({ children, color = MUTED }: { children: string; color?: string }) => (
  <div style={{ display: 'flex', fontFamily: SANS, fontWeight: 400, fontSize: 12, letterSpacing: 3.5, color }}>{children}</div>
);

/**
 * The certificate artwork (1200×850) as a Satori element tree. Shared by the PNG route, the builder preview and the
 * render test. Brand: SOGDIA.SITE wordmark; signed by the Corporate Department of SOGDIA CAPITAL INC.
 */
export function certificateElement(data: CertificateRow) {
  const type = effectiveType(data);
  const isPayout = type === 'payout';
  const { title, caption, amountLabel, hideAmount } = resolveCertificateCopy(type, data.metadata);
  const name = (data.display_name ?? 'SOGDIA Trader').trim() || 'SOGDIA Trader';
  const nameSize = name.length > 28 ? 54 : name.length > 20 ? 64 : 76;

  const issued = new Date(data.issued_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const accountSize = data.accounts?.size ? Number(data.accounts.size) : null;
  const showAccount = accountSize !== null && isPayout;

  return (
    <div style={{
      width: '100%', height: '100%', display: 'flex', background: BG, padding: 34,
      backgroundImage: `radial-gradient(ellipse at 50% 0%, ${BRAND}1F, transparent 58%)`,
    }}>
      {/* double frame */}
      <div style={{ display: 'flex', width: '100%', height: '100%', border: `1px solid ${BRAND}55`, borderRadius: 18, padding: 8 }}>
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', height: '100%',
          border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: '40px 64px 34px',
        }}>
          {/* brand */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ display: 'flex', width: 34, height: 34, borderRadius: 9, background: BRAND, alignItems: 'center', justifyContent: 'center', color: BG, fontFamily: SANS, fontWeight: 500, fontSize: 20 }}>S</div>
            <div style={{ display: 'flex', fontFamily: SANS, fontWeight: 500, fontSize: 25, letterSpacing: 6, color: INK }}>
              SOGDIA<span style={{ color: BRAND }}>.SITE</span>
            </div>
          </div>
          <div style={{ display: 'flex', marginTop: 10, fontFamily: SANS, fontWeight: 300, fontSize: 12.5, letterSpacing: 4, color: MUTED }}>
            SOGDIA CAPITAL INC. · INSTITUTIONAL CRYPTO PROP FIRM
          </div>

          {/* title */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginTop: 34 }}>
            <div style={{ display: 'flex', width: 54, height: 1, background: `${BRAND}66` }} />
            <div style={{ display: 'flex', fontFamily: SANS, fontWeight: 400, fontSize: 19, letterSpacing: 7, color: BRAND }}>{title}</div>
            <div style={{ display: 'flex', width: 54, height: 1, background: `${BRAND}66` }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flexGrow: 1, width: '100%' }}>
          <div style={{ display: 'flex', fontFamily: SERIF, fontStyle: 'italic', fontWeight: 400, fontSize: 25, color: TEXT }}>This is to certify that</div>

          {/* name */}
          <div style={{ display: 'flex', marginTop: 6, fontFamily: SERIF, fontWeight: 500, fontSize: nameSize, color: INK, letterSpacing: 0.5 }}>{name}</div>
          <div style={{ display: 'flex', width: 460, height: 1, marginTop: 6, backgroundImage: `linear-gradient(90deg, transparent, ${BRAND}88, transparent)` }} />

          <div style={{ display: 'flex', marginTop: 20, maxWidth: 760, justifyContent: 'center', textAlign: 'center', fontFamily: SANS, fontWeight: 300, fontSize: 19.5, lineHeight: 1.5, color: TEXT }}>
            {caption}
          </div>

          {/* figures */}
          {(!hideAmount || showAccount) && (
            <div style={{ display: 'flex', gap: 90, marginTop: 26 }}>
              {!hideAmount && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <Label>{amountLabel}</Label>
                  <div style={{ display: 'flex', marginTop: 4, fontFamily: FIG, fontWeight: 300, fontSize: 46, letterSpacing: 0.5, color: BRAND }}>{fmtUsd(Number(data.amount))}</div>
                </div>
              )}
              {showAccount && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <Label>ACCOUNT</Label>
                  <div style={{ display: 'flex', marginTop: 4, fontFamily: FIG, fontWeight: 300, fontSize: 46, letterSpacing: 0.5, color: INK }}>{`$${(accountSize! / 1000).toFixed(0)}K`}</div>
                </div>
              )}
            </div>
          )}

          </div>

          {/* date · seal · signature */}
          <div style={{ display: 'flex', width: '100%', alignItems: 'flex-end', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 260 }}>
              <div style={{ display: 'flex', fontFamily: SANS, fontWeight: 400, fontSize: 17, color: INK, paddingBottom: 10 }}>{issued}</div>
              <div style={{ display: 'flex', width: '100%', height: 1, background: 'rgba(255,255,255,0.18)' }} />
              <div style={{ display: 'flex', marginTop: 9 }}><Label>DATE OF ISSUE</Label></div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{ display: 'flex', width: 84, height: 84, borderRadius: 42, border: `1px solid ${BRAND}88`, alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ display: 'flex', width: 70, height: 70, borderRadius: 35, border: `1px dashed ${BRAND}55`, flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ display: 'flex', fontFamily: SERIF, fontWeight: 500, fontSize: 30, color: BRAND, lineHeight: 1 }}>S</div>
                  <div style={{ display: 'flex', fontFamily: SANS, fontWeight: 500, fontSize: 7.5, letterSpacing: 2, color: BRAND, marginTop: 2 }}>VERIFIED</div>
                </div>
              </div>
              <div style={{ display: 'flex', marginTop: 10, fontFamily: SANS, fontWeight: 400, fontSize: 12, letterSpacing: 2, color: MUTED }}>{`CODE ${data.code}`}</div>
              <div style={{ display: 'flex', marginTop: 3, fontFamily: SANS, fontWeight: 500, fontSize: 12, letterSpacing: 2.5, color: TEXT }}>SOGDIA.SITE</div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 260 }}>
              <div style={{ display: 'flex', fontFamily: 'Signature', fontSize: 50, color: '#E6EBF0', lineHeight: 1, marginBottom: -4, transform: 'rotate(-4deg)' }}>Sogdia Capital</div>
              <div style={{ display: 'flex', width: '100%', height: 1, background: 'rgba(255,255,255,0.18)' }} />
              <div style={{ display: 'flex', marginTop: 9, fontFamily: SANS, fontWeight: 400, fontSize: 13.5, color: TEXT }}>Corporate Department</div>
              <div style={{ display: 'flex', marginTop: 3 }}><Label color={`${BRAND}CC`}>SOGDIA CAPITAL INC.</Label></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
