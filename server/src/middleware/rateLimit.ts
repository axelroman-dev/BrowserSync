import rateLimit from "express-rate-limit";

/**
 * In-memory rate limiting is fine at "dozens of concurrent users" scale and
 * avoids adding Redis just to throttle login attempts. Applied per-route in
 * auth.ts, only to register/login/refresh/reset-password - the
 * credential-guessing-sensitive endpoints - NOT router-wide to every
 * /api/auth/* route. It used to be mounted ahead of the whole authRouter, so
 * routine authenticated calls (GET /me, GET /devices - what the account
 * dashboard polls on every page load) silently shared the same 20-per-15-min
 * budget as login attempts, and a handful of dashboard reloads could lock
 * someone out of their own account with "Too many attempts." Limits by IP,
 * which is coarse behind a shared NAT/office network, but is a reasonable
 * default for a homelab-hosted service; the limit is generous enough not to
 * lock out a whole office over one typo'd password.
 */
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited", message: "Too many attempts. Try again later." },
});
