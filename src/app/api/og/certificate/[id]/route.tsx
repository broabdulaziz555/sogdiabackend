import { ImageResponse } from 'next/og';
import { supabaseAdmin } from '@/lib/supabase';
import { certificateElement, certificateImageOptions, type CertificateRow } from '@/lib/certificateImage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const BG = '#070B10';

/** GET /api/og/certificate/{id} -> image/png (1200x850) */
export async function GET(_req: Request, ctx: { params: { id: string } }) {
  const { data } = await supabaseAdmin()
    .from('certificates')
    .select('*, accounts(size, type, plan_key)')
    .eq('id', ctx.params.id)
    .maybeSingle<CertificateRow>();

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

  return new ImageResponse(
    certificateElement(data),
    {
      ...certificateImageOptions(),
      headers: { 'cache-control': 'public, max-age=600, s-maxage=86400' },
    },
  );
}
