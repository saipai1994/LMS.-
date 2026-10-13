/** The browser talks to same-origin /api/*, proxied to the NestJS API (no CORS, no API URL in client code). */
const RAW = process.env.API_URL ?? 'http://localhost:3001';
const API = /^https?:\/\//.test(RAW) ? RAW : `http://${RAW}`; // Render's fromService gives host:port
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
