import type { NextConfig } from 'next';

const productExperienceUrl = (process.env['ANCHOR_PRODUCT_URL'] ?? 'http://127.0.0.1:4175').replace(/\/$/u, '');

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Produces a self-contained server bundle for the container image.
  output: 'standalone',
  outputFileTracingRoot: new URL('../..', import.meta.url).pathname,
  // The pixel-art Anchor experience is the only customer-facing application.
  // Keep the former evaluator URLs as compatibility redirects, not a second UI.
  async redirects() {
    return [
      { source: '/', destination: `${productExperienceUrl}/`, permanent: false },
      { source: '/company', destination: `${productExperienceUrl}/?role=company`, permanent: false },
      { source: '/freelancer', destination: `${productExperienceUrl}/?role=freelancer`, permanent: false },
      { source: '/supplier', destination: `${productExperienceUrl}/?role=freelancer`, permanent: false },
      { source: '/provider', destination: `${productExperienceUrl}/?role=company`, permanent: false },
      { source: '/admin', destination: `${productExperienceUrl}/?role=company`, permanent: false },
    ];
  },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        // No blockchain signing surface exists in the browser, so no wallet
        // extension or remote script is permitted to inject one.
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
      ],
    }];
  },
};

export default nextConfig;
