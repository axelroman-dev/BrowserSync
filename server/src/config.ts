import "dotenv/config";

/**
 * All server configuration comes from environment variables so the admin can
 * change behavior (e.g. closing registration) by editing .env / docker-compose
 * and restarting the container, never by editing code.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required("DATABASE_URL"),
  jwtSecret: required("JWT_SECRET"),
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL ?? "15m",
  refreshTokenTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 90),
  allowRegistration: (process.env.ALLOW_REGISTRATION ?? "true") === "true",
  // When false, "/" redirects to the account dashboard instead of showing the
  // public landing page (public/index.html).
  showLanding: (process.env.SHOW_LANDING ?? "true") === "true",
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  maxBlobBytes: Number(process.env.MAX_BLOB_BYTES ?? 5 * 1024 * 1024),
  // How many reverse-proxy hops to trust when reading the client IP from
  // X-Forwarded-For (used by the auth rate limiter). Defaults to 1, matching
  // the single-reverse-proxy setups this project documents (Nginx, or
  // cloudflared talking directly to this container). Bump it if you stack
  // more than one proxy in front; leave it at 0 if you expose this container
  // directly with no proxy at all, so a client can't spoof the header.
  trustProxyHops: Number(process.env.TRUST_PROXY_HOPS ?? 1),
  // Development only: creates a fixed account on startup - see db/devSeed.ts.
  devSeed: {
    enabled: process.env.DEV_SEED === "true",
    email: (process.env.DEV_SEED_EMAIL ?? "admin@browser.local").trim().toLowerCase(),
    password: process.env.DEV_SEED_PASSWORD ?? "Admin123.",
    passphrase: process.env.DEV_SEED_PASSPHRASE ?? "admin-browser-local-dev-0000",
  },
};
