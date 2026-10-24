/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Backend-only project: no frontend pages are shipped.
  experimental: {
    serverComponentsExternalPackages: ['@supabase/supabase-js'],
  },
  async headers() {
    // Nothing under /api may be stored by a browser, a proxy or a CDN - except the two deliberately cached public feeds
    // (leaderboard, market/symbols), which set their own revalidate.
    return [
      {
        source: '/api/:path((?!leaderboard|market/symbols).*)',
        headers: [{ key: 'Cache-Control', value: 'no-store, max-age=0' }],
      },
    ];
  },
};

module.exports = nextConfig;
