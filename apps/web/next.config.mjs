// Content-Security-Policy: Next.js needs inline scripts/styles for hydration, everything else is same-origin only.
// `frame-ancestors 'none'` + X-Frame-Options stop another page from framing the UI and tricking a click on "Approve".
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  // @ard/core loads node:sqlite and touches the file system: keep it a plain Node dependency, never bundle it.
  serverExternalPackages: ["@ard/core", "@ard/schema"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};

export default nextConfig;
