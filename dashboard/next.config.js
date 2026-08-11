/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The dashboard talks to the AI Gateway backend. In development we proxy
  // /api/gateway/* to the Express server so the browser never needs a
  // cross-origin request and the admin Bearer token stays same-origin.
  async rewrites() {
    const backend = process.env.GATEWAY_BACKEND_URL || 'http://127.0.0.1:3000';
    return [
      { source: '/api/gateway/:path*', destination: `${backend}/:path*` },
    ];
  },
};

module.exports = nextConfig;
