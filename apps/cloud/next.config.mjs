// Content-Security-Policy for the whole app. Next.js needs inline scripts/styles for hydration; everything else is same-origin.
// `frame-ancestors 'none'` + X-Frame-Options keep other sites from framing the pages (clickjacking on Approve / Subscribe buttons).
const base = {
  "default-src": ["'self'"],
  "script-src": ["'self'", "'unsafe-inline'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:"],
  "connect-src": ["'self'"],
  "frame-ancestors": ["'none'"],
  "base-uri": ["'none'"],
  // NO `form-action`. Chrome applies it to the redirect that FOLLOWS a form post, and our sign-in, SSO, "Pay with ..." and
  // "Open billing portal" buttons are form posts answered by a 303 to another site (the identity provider, the
  // checkout, the billing portal). `form-action 'self'` would make Chrome silently refuse every one of them, and the
  // list of allowed hosts cannot be known (customers bring their own SSO provider). Forged forms are stopped by
  // `assertSameOrigin` (Sec-Fetch-Site) and SameSite cookies instead.
};

/**
 * /pay is the page Paddle's "default payment link" points at. It must load Paddle.js (only from cdn.paddle.com, per
 * Paddle) and embed Paddle's checkout frame, so it alone gets extra sources. Paddle publishes no official CSP list,
 * so these use the paddle.com domain pattern: verify in the sandbox, and tighten if you can.
 */
const pay = {
  ...base,
  "script-src": ["'self'", "'unsafe-inline'", "https://cdn.paddle.com"],
  "style-src": ["'self'", "'unsafe-inline'", "https://cdn.paddle.com"],
  "img-src": ["'self'", "data:", "https://*.paddle.com"],
  "connect-src": ["'self'", "https://*.paddle.com"],
  "frame-src": ["https://*.paddle.com"],
};

const toHeader = (policy) => Object.entries(policy).map(([k, v]) => `${k} ${v.join(" ")}`).join("; ");

const common = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Cache-Control", value: "no-store" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(self)" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  transpilePackages: ["@ard/ui"],
  // These load node:sqlite and touch the file system: keep them plain Node dependencies, never bundle them.
  serverExternalPackages: ["@ard/cloud", "@ard/core", "@ard/billing", "@ard/schema"],
  async headers() {
    return [
      { source: "/:path*", headers: [...common, { key: "Content-Security-Policy", value: toHeader(base) }] },
      // Later entries win for the same header: /pay replaces the CSP.
      { source: "/pay", headers: [{ key: "Content-Security-Policy", value: toHeader(pay) }] },
    ];
  },
};

export default nextConfig;
