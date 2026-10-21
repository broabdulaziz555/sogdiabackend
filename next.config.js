/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Backend-only project: no frontend pages are shipped.
  experimental: {
    serverComponentsExternalPackages: ['@supabase/supabase-js'],
  },
};

module.exports = nextConfig;
