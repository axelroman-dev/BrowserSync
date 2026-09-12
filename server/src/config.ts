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
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  maxBlobBytes: Number(process.env.MAX_BLOB_BYTES ?? 5 * 1024 * 1024),
};
