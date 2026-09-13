import { Router } from "express";
import { z } from "zod";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { users, refreshTokens } from "../db/schema.js";
import { config } from "../config.js";
import {
  hashPassword,
  verifyPassword,
  signAccessToken,
  generateRefreshToken,
  hashRefreshToken,
} from "../services/authService.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const authRouter = Router();

const emailSchema = z.string().trim().toLowerCase().email().max(320);
const passwordSchema = z.string().min(8, "Password must be at least 8 characters").max(512);
// Base64-encoded PBKDF2 output (see extension/lib/crypto.js derivePassphraseVerifier) -
// never the raw passphrase itself.
const passphraseVerifierSchema = z.string().min(1).max(512);
const dekEnvelopeSchema = z.object({
  ciphertext: z.string().min(1),
  iv: z.string().min(1),
});

const credentialsSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  deviceLabel: z.string().trim().max(120).optional(),
});

function refreshTokenExpiry(): Date {
  return new Date(Date.now() + config.refreshTokenTtlDays * 24 * 60 * 60 * 1000);
}

async function issueTokenPair(userId: string, deviceLabel: string | undefined) {
  const accessToken = signAccessToken(userId);
  const { token: refreshToken, hash } = generateRefreshToken();
  const [inserted] = await db
    .insert(refreshTokens)
    .values({
      userId,
      tokenHash: hash,
      deviceLabel: deviceLabel ?? null,
      expiresAt: refreshTokenExpiry(),
    })
    .returning({ id: refreshTokens.id });
  // deviceId lets the client remember which /devices row is itself, so the
  // "linked devices" list can point out "this device" instead of leaving the
  // user to guess from the label alone - see extension/lib/auth.js.
  return { accessToken, refreshToken, deviceId: inserted.id };
}

const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  passphraseVerifier: passphraseVerifierSchema,
  dekEnvelope: dekEnvelopeSchema,
  deviceLabel: z.string().trim().max(120).optional(),
});

authRouter.post("/register", async (req, res) => {
  if (!config.allowRegistration) {
    res.status(403).json({ error: "registration_disabled", message: "Registration is currently closed on this server." });
    return;
  }

  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const { email, password, passphraseVerifier, dekEnvelope, deviceLabel } = parsed.data;

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  // Case-insensitive collision check happens via the unique index too, but
  // checking here lets us return a clean 409 instead of a raw DB error.
  if (existing) {
    res.status(409).json({ error: "email_taken", message: "An account with this email already exists." });
    return;
  }

  const [passwordHash, passphraseVerifierHash] = await Promise.all([
    hashPassword(password),
    hashPassword(passphraseVerifier),
  ]);
  const [user] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      passphraseVerifierHash,
      dekEnvelopeCiphertext: dekEnvelope.ciphertext,
      dekEnvelopeIv: dekEnvelope.iv,
    })
    .returning();

  const tokens = await issueTokenPair(user.id, deviceLabel);
  res.status(201).json(tokens);
});

authRouter.post("/login", async (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const { email, password, deviceLabel } = parsed.data;

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const genericError = { error: "invalid_credentials", message: "Email or password is incorrect." };
  if (!user) {
    res.status(401).json(genericError);
    return;
  }

  const valid = await verifyPassword(user.passwordHash, password);
  if (!valid) {
    res.status(401).json(genericError);
    return;
  }

  const tokens = await issueTokenPair(user.id, deviceLabel);
  // Every login returns the wrapped DEK so a device that doesn't have a
  // local password-wrapped copy yet (a fresh install) can bootstrap itself
  // after a one-time passphrase prompt - see auth.js's completeDeviceSetup.
  res.json({ ...tokens, dekEnvelope: { ciphertext: user.dekEnvelopeCiphertext, iv: user.dekEnvelopeIv } });
});

// Lets an already-authenticated device re-fetch its account's wrapped DEK on
// demand - used when a device's local password-wrapped copy is missing or
// corrupted, without forcing a full re-login.
authRouter.get("/dek-envelope", requireAuth, async (req, res) => {
  const [user] = await db
    .select({ dekEnvelopeCiphertext: users.dekEnvelopeCiphertext, dekEnvelopeIv: users.dekEnvelopeIv })
    .from(users)
    .where(eq(users.id, req.userId!))
    .limit(1);
  if (!user) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ dekEnvelope: { ciphertext: user.dekEnvelopeCiphertext, iv: user.dekEnvelopeIv } });
});

const resetPasswordSchema = z.object({
  email: emailSchema,
  passphraseVerifier: passphraseVerifierSchema,
  newPassword: passwordSchema,
});

authRouter.post("/reset-password", async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const { email, passphraseVerifier, newPassword } = parsed.data;

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const genericError = { error: "invalid_credentials", message: "Email or recovery passphrase is incorrect." };
  if (!user) {
    res.status(401).json(genericError);
    return;
  }

  const valid = await verifyPassword(user.passphraseVerifierHash, passphraseVerifier);
  if (!valid) {
    res.status(401).json(genericError);
    return;
  }

  const newPasswordHash = await hashPassword(newPassword);
  await db.update(users).set({ passwordHash: newPasswordHash }).where(eq(users.id, user.id));

  // Every existing session (and every device's local password-wrapped DEK
  // copy) was tied to the old password. Revoking all refresh tokens forces
  // a fresh login everywhere, which is also when each device rebuilds its
  // local envelope under the new password.
  await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.userId, user.id));

  res.json({ dekEnvelope: { ciphertext: user.dekEnvelopeCiphertext, iv: user.dekEnvelopeIv } });
});

// Lists every device (non-revoked, non-expired refresh token) currently
// signed into this account, so the account owner can see what's linked and
// revoke anything they don't recognize/still use without having to log out
// everywhere - the "logged in devices" list a reviewer of the raw DB could
// already see, now surfaced to the user themselves.
authRouter.get("/devices", requireAuth, async (req, res) => {
  const rows = await db
    .select({
      id: refreshTokens.id,
      deviceLabel: refreshTokens.deviceLabel,
      createdAt: refreshTokens.createdAt,
      lastUsedAt: refreshTokens.lastUsedAt,
      expiresAt: refreshTokens.expiresAt,
    })
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.userId, req.userId!),
        isNull(refreshTokens.revokedAt),
        gt(refreshTokens.expiresAt, new Date()),
      ),
    )
    .orderBy(refreshTokens.createdAt);
  res.json({ devices: rows });
});

const deviceIdParamSchema = z.object({ id: z.string().uuid() });

// Revokes one device's refresh token - functionally identical to /logout,
// but callable for ANY of the account's devices (by id) rather than only the
// one presenting its own token, and gated by the access token instead of the
// refresh token being revoked. The now-revoked device keeps working until
// its current access token expires, then fails to refresh and is signed out.
authRouter.delete("/devices/:id", requireAuth, async (req, res) => {
  const parsedParams = deviceIdParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({ error: "invalid_input", message: "Invalid device id" });
    return;
  }

  const [row] = await db
    .select({ id: refreshTokens.id })
    .from(refreshTokens)
    .where(and(eq(refreshTokens.id, parsedParams.data.id), eq(refreshTokens.userId, req.userId!)))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "not_found", message: "Device not found." });
    return;
  }

  await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, row.id));
  res.status(204).send();
});

const refreshSchema = z.object({ refreshToken: z.string().min(1) });

authRouter.post("/refresh", async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", message: "refreshToken is required" });
    return;
  }

  const tokenHash = hashRefreshToken(parsed.data.refreshToken);
  const [row] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash)).limit(1);

  if (!row || row.revokedAt || row.expiresAt < new Date()) {
    res.status(401).json({ error: "invalid_refresh_token", message: "Please log in again." });
    return;
  }

  await db.update(refreshTokens).set({ lastUsedAt: new Date() }).where(eq(refreshTokens.id, row.id));

  const accessToken = signAccessToken(row.userId);
  res.json({ accessToken });
});

authRouter.post("/logout", async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", message: "refreshToken is required" });
    return;
  }
  // Revoking only the presented token logs out exactly this device, not
  // every device signed into the account.
  const tokenHash = hashRefreshToken(parsed.data.refreshToken);
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(eq(refreshTokens.tokenHash, tokenHash));
  res.status(204).send();
});

const deleteAccountSchema = z.object({ password: z.string().min(1) });

authRouter.delete("/account", requireAuth, async (req, res) => {
  const parsed = deleteAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", message: "password is required to confirm deletion" });
    return;
  }

  const [user] = await db.select().from(users).where(eq(users.id, req.userId!)).limit(1);
  if (!user) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const valid = await verifyPassword(user.passwordHash, parsed.data.password);
  if (!valid) {
    res.status(401).json({ error: "invalid_credentials", message: "Password is incorrect." });
    return;
  }

  // ON DELETE CASCADE on refresh_tokens and sync_blobs does the rest.
  await db.delete(users).where(eq(users.id, user.id));
  res.status(204).send();
});
