import argon2 from "argon2";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { config } from "../config.js";

/**
 * argon2id is the OWASP-recommended password hash: resistant to both GPU
 * cracking (memory-hard) and side-channel timing attacks (unlike argon2i).
 * Defaults are argon2's own recommended baseline; no need to tune them for
 * "dozens of users" scale.
 */
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

export interface AccessTokenPayload {
  userId: string;
}

/**
 * Access tokens are short-lived JWTs verified locally (no DB round trip) on
 * every request. They intentionally carry no email/PII beyond the user id.
 */
export function signAccessToken(userId: string): string {
  return jwt.sign({ userId } satisfies AccessTokenPayload, config.jwtSecret, {
    // ACCESS_TOKEN_TTL is a free-form env var (e.g. "15m"); jwt's types want
    // its own branded string literal type, so it's cast at this one boundary.
    expiresIn: config.accessTokenTtl as jwt.SignOptions["expiresIn"],
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, config.jwtSecret) as AccessTokenPayload;
}

/**
 * Refresh tokens are opaque random strings, not JWTs: they must be
 * revocable per-device (see refresh_tokens table), which a self-contained
 * signed token can't support without a separate blocklist anyway. Only the
 * SHA-256 hash is ever persisted, so a database leak doesn't leak usable
 * long-lived credentials.
 */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(48).toString("base64url");
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
