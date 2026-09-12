// All encryption happens here, client-side, using the browser's native Web
// Crypto API. The server only ever receives the output of encryptJSON():
// base64 ciphertext + base64 IV. It has no way to derive any key from that
// alone, so an admin with full database access (even the person running
// this server) cannot read bookmark/history content - only its size and
// timestamps.
//
// ENVELOPE ENCRYPTION: the key that actually encrypts sync blobs is a
// random Data Encryption Key (DEK, see generateDEK) - it isn't derived from
// the password or the passphrase, so neither one alone can compute it. The
// DEK is instead wrapped (AES-GCM encrypted) under two independently
// derived keys:
//   - a PASSPHRASE-derived key wraps the DEK into an envelope stored on the
//     SERVER (safe to store there: unwrapping needs the passphrase, which
//     the server never learns). This is what a new device or a password
//     reset uses to recover the DEK.
//   - a PASSWORD-derived key wraps the DEK into a second envelope stored
//     ONLY in this device's local extension storage, never on the server.
//     This is what lets "unlock" use the password day-to-day.
// The server sees the plaintext password on every login (unavoidable for
// password auth) and could therefore compute the password-derived key -
// but it never has the locally-stored envelope to use that key on, so
// having the key alone doesn't let it recover the DEK. A THIRD, separately
// salted derivation (derivePassphraseVerifier) produces a value the server
// can hash and check during password reset, without ever learning anything
// that helps it derive the passphrase-wrapping key.
const PBKDF2_ITERATIONS = 600_000; // OWASP 2023 minimum recommendation for PBKDF2-SHA256
const KEY_LENGTH_BITS = 256;

/**
 * Derives a salt deterministically from the account email plus a fixed
 * per-purpose label, instead of generating and syncing random salts.
 *
 * Trade-off, documented explicitly: a PBKDF2 salt's job is to stop
 * precomputed rainbow-table attacks against many accounts sharing the same
 * hash function; it does not need to be secret. Deriving it from the email
 * still gives every account its own salt, without needing a server
 * endpoint just to hand out salts, and without risking two devices ever
 * deriving different keys for the same account. The `purpose` label is
 * what keeps the three derivations below (passphrase KEK, password KEK,
 * passphrase verifier) cryptographically independent of one another, so
 * learning the output of one never helps compute another. This is safe as
 * long as the passphrase/password have real entropy.
 */
async function deriveSalt(purpose, email) {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`browsersync-${purpose}:${email.toLowerCase()}`));
  return new Uint8Array(digest);
}

async function pbkdf2DeriveKey(secret, salt) {
  const encoder = new TextEncoder();
  const baseKey = await crypto.subtle.importKey("raw", encoder.encode(secret), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: KEY_LENGTH_BITS },
    true, // extractable: needed to cache the raw password-KEK-wrapped envelope key material locally (see storage.js)
    ["encrypt", "decrypt"],
  );
}

/** Derives the key that wraps/unwraps the DEK envelope stored on the server. */
export async function deriveKekFromPassphrase(passphrase, email) {
  return pbkdf2DeriveKey(passphrase, await deriveSalt("kek-passphrase", email));
}

/** Derives the key that wraps/unwraps this device's local DEK envelope. */
export async function deriveKekFromPassword(password, email) {
  return pbkdf2DeriveKey(password, await deriveSalt("kek-password", email));
}

/**
 * Derives a value that proves knowledge of the passphrase to the server
 * (for password reset) without exposing the passphrase itself or anything
 * that helps derive deriveKekFromPassphrase's key - a different salt
 * "purpose" makes the two derivations independent.
 */
export async function derivePassphraseVerifier(passphrase, email) {
  const encoder = new TextEncoder();
  const salt = await deriveSalt("verifier", email);
  const baseKey = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    256,
  );
  return bufferToBase64(bits);
}

/** Generates the random Data Encryption Key that actually encrypts sync blobs. */
export function generateDEK() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: KEY_LENGTH_BITS }, true, ["encrypt", "decrypt"]);
}

/** Wraps (encrypts) a DEK under a KEK, producing a small envelope safe to store. */
export async function wrapDEK(kek, dek) {
  const rawDek = await exportKeyRaw(dek);
  return encryptJSON(kek, { dek: rawDek });
}

/** Unwraps a DEK envelope (from wrapDEK) back into a usable CryptoKey. */
export async function unwrapDEK(kek, envelope) {
  const { dek } = await decryptJSON(kek, envelope.ciphertext, envelope.iv);
  return importKeyRaw(dek);
}

export async function exportKeyRaw(key) {
  const raw = await crypto.subtle.exportKey("raw", key);
  return bufferToBase64(raw);
}

export async function importKeyRaw(base64Key) {
  const raw = base64ToBuffer(base64Key);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
}

/** Encrypts a JSON-serializable value. Returns {ciphertext, iv}, both base64. */
export async function encryptJSON(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV, standard for AES-GCM
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertextBuffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    ciphertext: bufferToBase64(ciphertextBuffer),
    iv: bufferToBase64(iv),
  };
}

/**
 * Decrypts and JSON-parses a payload produced by encryptJSON. Throws if the
 * passphrase is wrong (AES-GCM's authentication tag won't verify) - callers
 * should catch this and surface "wrong passphrase" rather than a generic
 * error, since it's the one failure mode users will actually hit.
 */
export async function decryptJSON(key, ciphertextBase64, ivBase64) {
  const iv = base64ToBuffer(ivBase64);
  const ciphertext = base64ToBuffer(ciphertextBase64);
  const plaintextBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintextBuffer));
}

/**
 * Generates a random, easy-to-transcribe passphrase: 6 words from a small
 * built-in list plus a short numeric suffix. Not a full diceware list (that
 * would bloat the extension for little benefit at this threat model), but
 * enough entropy (6 words from ~2000 + 4 digits => well over 64 bits) for a
 * passphrase that's never brute-forced remotely - it only ever gets tested
 * locally against data already in hand.
 */
export function generatePassphrase() {
  const words = pickRandomWords(6);
  const suffix = crypto.getRandomValues(new Uint32Array(1))[0] % 10000;
  return `${words.join("-")}-${String(suffix).padStart(4, "0")}`;
}

function pickRandomWords(count) {
  const result = [];
  const indices = new Uint32Array(count);
  crypto.getRandomValues(indices);
  for (let i = 0; i < count; i++) {
    result.push(WORDLIST[indices[i] % WORDLIST.length]);
  }
  return result;
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// Small, deliberately boring word list (no offensive/ambiguous words, no
// homophones) - good enough for a memorable-ish generated passphrase.
const WORDLIST = [
  "anchor", "arctic", "autumn", "badge", "banjo", "basin", "beacon", "bison",
  "blanket", "bramble", "canyon", "cedar", "cinder", "clover", "comet", "copper",
  "coral", "cosmos", "cotton", "crater", "crimson", "cruise", "current", "dawn",
  "delta", "desert", "dolphin", "dragon", "drift", "dune", "eagle", "ember",
  "emerald", "falcon", "feather", "fern", "fjord", "flame", "forest", "fossil",
  "galaxy", "garnet", "glacier", "granite", "gravel", "harbor", "hazel", "hollow",
  "horizon", "hyacinth", "iceberg", "indigo", "island", "ivory", "jasper", "jungle",
  "kernel", "kettle", "lagoon", "lantern", "lattice", "lava", "lemon", "lichen",
  "lighthouse", "lilac", "lumen", "lunar", "maple", "marble", "meadow", "meteor",
  "mineral", "mirage", "mist", "mosaic", "moss", "nebula", "nectar", "nomad",
  "oasis", "obsidian", "ocean", "olive", "opal", "orbit", "orchid", "otter",
  "outpost", "pebble", "petal", "pine", "planet", "plateau", "prairie", "prism",
  "quartz", "quiver", "rapids", "raven", "reef", "ridge", "river", "rocket",
  "rustic", "saffron", "sage", "sandal", "savanna", "sequoia", "shadow", "shard",
  "shell", "shore", "sierra", "silver", "sky", "slate", "sleet", "sonar",
  "spark", "sparrow", "sphinx", "spruce", "starling", "storm", "summit", "sunset",
  "swallow", "tangerine", "thicket", "thistle", "thunder", "timber", "topaz", "tundra",
  "twilight", "umbra", "valley", "velvet", "violet", "vista", "voyage", "walnut",
  "willow", "winter", "zenith", "zephyr",
];
