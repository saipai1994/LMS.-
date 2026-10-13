/** The browser talks to same-origin /api/*, proxied to the NestJS API (no CORS, no API URL in client code). */
const API = process.env.API_URL ?? 'http://localhost:3001';
export default {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() { return [{ source: '/api/:path*', destination: `${API}/:path*` }]; },
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'X-Frame-Options', value: 'DENY' }, { key: 'Referrer-Policy', value: 'same-origin' },
    ] }];
  },
};
