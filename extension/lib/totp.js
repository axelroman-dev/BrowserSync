// Time-based one-time passwords (RFC 6238) for vault entries that store a
// 2FA secret in `entry.totp`. That field holds what the user pasted, as
// long as parseTotp() accepts it: a bare base32 secret ("JBSW Y3DP ...") or
// an otpauth://totp/... link (what sites encode in their 2FA QR code, and
// what Bitwarden exports). Codes are computed with Web Crypto's HMAC - no
// library, nothing leaves the device.
//
// Keeping the 2FA secret next to the password means whoever opens the vault
// has both factors. That's the same trade-off Bitwarden makes; the vault
// page says so where the field is filled in.
const ALGORITHMS = { SHA1: "SHA-1", SHA256: "SHA-256", SHA512: "SHA-512" };
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input) {
  const clean = input.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  if (!clean || /[^A-Z2-7]/.test(clean)) return null;
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/**
 * Parses a stored/pasted TOTP value into { key, algorithm, digits, period,
 * issuer, account }, or returns null when it isn't a usable secret. Only
 * the standard parameter ranges are accepted, so a malformed link fails
 * here instead of silently producing codes the site will reject.
 */
export function parseTotp(value) {
  const input = (value ?? "").trim();
  if (!input) return null;

  let secret = input;
  let algorithm = "SHA1";
  let digits = 6;
  let period = 30;
  let issuer = "";
  let account = "";

  if (/^otpauth:/i.test(input)) {
    let url;
    try {
      url = new URL(input);
    } catch {
      return null;
    }
    if (url.host.toLowerCase() !== "totp") return null; // HOTP (counter-based) isn't supported
    const params = url.searchParams;
    secret = params.get("secret") ?? "";
    algorithm = (params.get("algorithm") ?? "SHA1").toUpperCase();
    digits = Number(params.get("digits") ?? 6);
    period = Number(params.get("period") ?? 30);
    const label = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    [issuer, account] = label.includes(":") ? label.split(/:(.*)/s, 2) : ["", label];
    issuer = params.get("issuer") ?? issuer;
  }

  const key = base32Decode(secret);
  if (!key || key.length < 10) return null; // RFC 4226 asks for at least 128 bits; 80 is what many sites really use
  if (!ALGORITHMS[algorithm] || ![6, 7, 8].includes(digits) || !(period >= 10 && period <= 120)) return null;
  return { key, algorithm, digits, period, issuer: issuer.trim(), account: account.trim() };
}

/** The code valid at `timeMs` plus how many seconds it has left. */
export async function generateTotp(config, timeMs = Date.now()) {
  const counter = Math.floor(timeMs / 1000 / config.period);
  const message = new ArrayBuffer(8);
  const view = new DataView(message);
  // 64-bit big-endian counter; high 32 bits via division so this stays
  // correct past 2038 without BigInt.
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);

  const hmacKey = await crypto.subtle.importKey("raw", config.key, { name: "HMAC", hash: ALGORITHMS[config.algorithm] }, false, [
    "sign",
  ]);
  const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, message));
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  const code = String(binary % 10 ** config.digits).padStart(config.digits, "0");
  const remaining = config.period - (Math.floor(timeMs / 1000) % config.period);
  return { code, remaining };
}

/** "123456" -> "123 456", for display only; copy/fill always use the plain code. */
export function formatTotp(code) {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}
