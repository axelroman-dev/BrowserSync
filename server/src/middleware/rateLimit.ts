import rateLimit from "express-rate-limit";

/**
 * In-memory rate limiting is fine at "dozens of concurrent users" scale and
 * avoids adding Redis just to throttle login attempts. Scoped to /api/auth/*
 * only (register/login/refresh) - sync traffic from legitimate devices is
 * unaffected. Limits by IP, which is coarse behind a shared NAT/office
 * network, but is a reasonable default for a homelab-hosted service; the
 * limit is generous enough not to lock out a whole office over one typo'd
 * password.
 */
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited", message: "Too many attempts. Try again later." },
});
