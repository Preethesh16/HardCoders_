import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Produces a self-contained server bundle for the container image.
  output: 'standalone',
  outputFileTracingRoot: new URL('../..', import.meta.url).pathname,
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
