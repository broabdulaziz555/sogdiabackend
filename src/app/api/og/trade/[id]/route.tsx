import { ImageResponse } from 'next/og';
import { supabaseAdmin } from '@/lib/supabase';
import { pnlPct } from '@/lib/math';
import type { DbOrder } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const BRAND = '#00E08F';
const LOSS = '#FF4D6D';
const BG = '#070B10';

function fmt(n: number, dp = 2) {
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** GET /api/og/trade/{id} -> image/png (1200x630) */
export async function GET(_req: Request, ctx: { params: { id: string } }) {
  const { data } = await supabaseAdmin()
    .from('orders')
    .select('*')
    .eq('id', ctx.params.id)
    .maybeSingle<DbOrder>();

  if (!data) {
    return new ImageResponse(
      (
        <div
          style={{
            width: '100%', height: '100%', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            background: BG, color: '#9AA7B4', fontSize: 44,
          }}
        >
          Trade not found
        </div>
      ),
      { width: 1200, height: 630 },
    );
  }

  const isLong = data.side === 'long';
  const entry = Number(data.entry_price);
  const close = data.close_price === null ? null : Number(data.close_price);
  const pnl = data.pnl === null ? null : Number(data.pnl);
  const roi = pnl === null ? null : pnlPct(pnl, Number(data.margin));
  const positive = (roi ?? 0) >= 0;
  const accent = positive ? BRAND : LOSS;

  const rows: Array<[string, string]> = [
    ['Entry', `$${fmt(entry, entry < 10 ? 6 : 2)}`],
    [close === null ? 'Mark' : 'Exit', close === null ? '—' : `$${fmt(close, close < 10 ? 6 : 2)}`],
    ['Margin', `$${fmt(Number(data.margin))}`],
    ['Size', `$${fmt(Number(data.position_size))}`],
  ];

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
          background: BG, padding: 64, color: '#FFFFFF',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          backgroundImage: `radial-gradient(900px 420px at 85% -10%, ${accent}22, transparent)`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{
              width: 44, height: 44, borderRadius: 12, background: BRAND,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: BG, fontSize: 26, fontWeight: 800,
            }}>S</div>
            <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: 6 }}>SOGDIA</div>
          </div>
          <div style={{
            display: 'flex', fontSize: 22, color: '#8A99A8',
            border: '1px solid #1C2733', borderRadius: 999, padding: '10px 22px',
          }}>
            {data.status === 'liquidated' ? 'LIQUIDATED' : data.status === 'open' ? 'OPEN' : 'CLOSED'}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginTop: 56 }}>
          <div style={{ fontSize: 76, fontWeight: 800 }}>{data.symbol}</div>
          <div style={{
            display: 'flex', background: isLong ? `${BRAND}1F` : `${LOSS}1F`,
            color: isLong ? BRAND : LOSS, borderRadius: 10,
            padding: '10px 20px', fontSize: 28, fontWeight: 700,
          }}>
            {isLong ? 'LONG' : 'SHORT'} {data.leverage}x
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 24, marginTop: 24 }}>
          <div style={{ fontSize: 132, fontWeight: 800, color: accent, lineHeight: 1 }}>
            {roi === null ? '—' : `${positive ? '+' : ''}${fmt(roi)}%`}
          </div>
          {pnl !== null && (
            <div style={{ fontSize: 40, color: accent, paddingBottom: 18 }}>
              {positive ? '+' : '−'}${fmt(Math.abs(pnl))}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 56, marginTop: 'auto' }}>
          {rows.map(([label, value]) => (
            <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 22, color: '#6E7D8C', letterSpacing: 1 }}>{label.toUpperCase()}</div>
              <div style={{ fontSize: 34, fontWeight: 600 }}>{value}</div>
            </div>
          ))}
        </div>

        <div style={{
          display: 'flex', marginTop: 32, fontSize: 20, letterSpacing: 3, color: '#6E7D8C',
        }}>
          SOGDIA.SITE · INSTITUTIONAL CRYPTO PROP FIRM
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      headers: {
        'cache-control':
          data.status === 'open' ? 'no-store' : 'public, max-age=300, s-maxage=3600',
      },
    },
  );
}
