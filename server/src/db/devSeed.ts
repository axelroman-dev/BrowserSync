import { eq } from "drizzle-orm";
import { db } from "./client.js";
import { users } from "./schema.js";
import { config } from "../config.js";
import { hashPassword } from "../services/authService.js";
import { setDevAccountId } from "../middleware/devAccountLocalOnly.js";

// Creates a fixed account on startup so a development server is usable
// right away, without going through registration in the extension each
// time. Only runs when DEV_SEED=true - NEVER turn that on for a real
// server: the credentials are public defaults.
//
// Registration normally happens in the extension, which derives the keys
// client-side (extension/lib/crypto.js). The account is built here the same
// way: a random DEK wrapped under the passphrase-derived key, plus the
// passphrase verifier. Any change to that derivation must be mirrored here.
// The first login on each device then asks for the passphrase once, like
// any account signing in on a new device.
const PBKDF2_ITERATIONS = 600_000;
const { subtle } = globalThis.crypto;

function deriveSalt(purpose: string, email: string) {
  return subtle.digest("SHA-256", new TextEncoder().encode(`browsersync-${purpose}:${email.toLowerCase()}`));
}

async function pbkdf2Bits(secret: string, salt: ArrayBuffer) {
  const baseKey = await subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveBits"]);
  return subtle.deriveBits({ name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, baseKey, 256);
}

const toBase64 = (buffer: ArrayBuffer | Uint8Array) => Buffer.from(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)).toString("base64");

/** What the extension's register() sends: the passphrase verifier and the passphrase-wrapped random DEK. */
export async function buildAccountKeys(email: string, passphrase: string) {
  const kek = await subtle.importKey("raw", await pbkdf2Bits(passphrase, await deriveSalt("kek-passphrase", email)), "AES-GCM", false, [
    "encrypt",
  ]);
  const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  // Same shape as the extension's wrapDEK(): encryptJSON(kek, { dek: base64 }).
  const plaintext = new TextEncoder().encode(JSON.stringify({ dek: toBase64(dek) }));
  const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv }, kek, plaintext);
  const verifier = toBase64(await pbkdf2Bits(passphrase, await deriveSalt("verifier", email)));
  return { verifier, dekEnvelope: { ciphertext: toBase64(ciphertext), iv: toBase64(iv) } };
}

/**
 * Creates the development account when DEV_SEED is on, and in every case
 * records its id (if it exists) so it's restricted to local requests - see
 * middleware/devAccountLocalOnly.ts.
 */
export async function seedDevAccount() {
  const { email, password, passphrase } = config.devSeed;

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  setDevAccountId(existing?.id ?? null);
  if (!config.devSeed.enabled) return;
  if (existing) {
    console.warn(`DEV_SEED: account ${email} already exists, leaving it as is.`);
    return;
  }

  const { verifier, dekEnvelope } = await buildAccountKeys(email, passphrase);
  const [passwordHash, passphraseVerifierHash] = await Promise.all([hashPassword(password), hashPassword(verifier)]);
  const [user] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      passphraseVerifierHash,
      dekEnvelopeCiphertext: dekEnvelope.ciphertext,
      dekEnvelopeIv: dekEnvelope.iv,
    })
    .returning({ id: users.id });
  setDevAccountId(user.id);
  console.warn(`DEV_SEED: created development account ${email} (local server URLs only). Never enable DEV_SEED on a real server.`);
}
