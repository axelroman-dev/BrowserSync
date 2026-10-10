// Password generator shared by the vault dialog, the popup, the in-page
// menu and the right-click menu. Two kinds:
//
//   chars - random characters from the enabled sets (a-z, A-Z, 0-9,
//           symbols). Every enabled set appears at least once, since many
//           sites reject a password without a digit or symbol. That's done
//           by rejection - draw the whole password uniformly, redraw if a
//           set is missing - so the result is uniform over all valid
//           passwords, and bitsOf() can count them exactly.
//   words - a passphrase from the EFF large wordlist (7776 words, ~12.9
//           bits each; lib/data/, from eff.org, CC BY 3.0 US), easier to
//           type and remember at the same strength.
//
// All randomness is crypto.getRandomValues, with rejection sampling so no
// index is favored. The options are a device preference in
// chrome.storage.local (passwordGeneratorOptions).
import { getAllLocal, setLocal } from "./storage.js";

const CHARSETS = {
  lower: "abcdefghijklmnopqrstuvwxyz",
  upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  digits: "0123456789",
  symbols: "!@#$%^&*-_=+?.",
};
// Look-alikes left out when avoidAmbiguous is on, so a password can be read
// out and retyped by hand.
const AMBIGUOUS = /[lIO01]/g;

export const LIMITS = {
  length: { min: 8, max: 128 },
  words: { min: 3, max: 12 },
  separatorMaxLength: 3,
};

export const DEFAULT_GENERATOR_OPTIONS = {
  type: "chars",
  length: 20,
  lower: true,
  upper: true,
  digits: true,
  symbols: true,
  avoidAmbiguous: true,
  words: 5,
  separator: "-",
  capitalize: true,
  includeNumber: true,
};

const clamp = (value, { min, max }, fallback) => (Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback);
const bool = (value, fallback) => (typeof value === "boolean" ? value : fallback);

/** Fills in defaults and clamps anything out of range, so stored or typed options can't break generation. */
export function normalizeGeneratorOptions(raw) {
  const d = DEFAULT_GENERATOR_OPTIONS;
  const options = {
    type: raw?.type === "words" ? "words" : "chars",
    length: clamp(raw?.length, LIMITS.length, d.length),
    lower: bool(raw?.lower, d.lower),
    upper: bool(raw?.upper, d.upper),
    digits: bool(raw?.digits, d.digits),
    symbols: bool(raw?.symbols, d.symbols),
    avoidAmbiguous: bool(raw?.avoidAmbiguous, d.avoidAmbiguous),
    words: clamp(raw?.words, LIMITS.words, d.words),
    separator: typeof raw?.separator === "string" ? raw.separator.slice(0, LIMITS.separatorMaxLength) : d.separator,
    capitalize: bool(raw?.capitalize, d.capitalize),
    includeNumber: bool(raw?.includeNumber, d.includeNumber),
  };
  // At least one character set, or there's nothing to draw from.
  if (!options.lower && !options.upper && !options.digits && !options.symbols) options.lower = true;
  return options;
}

export async function loadGeneratorOptions() {
  const { passwordGeneratorOptions } = await getAllLocal();
  return normalizeGeneratorOptions(passwordGeneratorOptions);
}

export async function saveGeneratorOptions(options) {
  const normalized = normalizeGeneratorOptions(options);
  await setLocal({ passwordGeneratorOptions: normalized });
  return normalized;
}

/** Uniform random integer in [0, max). */
function randomIndex(max) {
  const limit = Math.floor(0x100000000 / max) * max;
  const buffer = new Uint32Array(1);
  do {
    crypto.getRandomValues(buffer);
  } while (buffer[0] >= limit);
  return buffer[0] % max;
}

function enabledSets(options) {
  return ["lower", "upper", "digits", "symbols"]
    .filter((name) => options[name])
    .map((name) => (options.avoidAmbiguous ? CHARSETS[name].replace(AMBIGUOUS, "") : CHARSETS[name]));
}

function generateChars(options) {
  const sets = enabledSets(options);
  const all = sets.join("");
  for (;;) {
    let password = "";
    for (let i = 0; i < options.length; i++) password += all[randomIndex(all.length)];
    if (sets.every((set) => [...password].some((char) => set.includes(char)))) return password;
  }
}

/**
 * Exact strength of a chars password: log2 of how many passwords of this
 * length contain every enabled set (inclusion-exclusion over the sets that
 * could be missing).
 */
function charsBits(options) {
  const sizes = enabledSets(options).map((set) => set.length);
  const total = sizes.reduce((a, b) => a + b, 0);
  const length = BigInt(options.length);
  let count = 0n;
  for (let mask = 0; mask < 1 << sizes.length; mask++) {
    let missing = 0;
    let bits = 0;
    sizes.forEach((size, i) => {
      if (mask & (1 << i)) {
        missing += size;
        bits++;
      }
    });
    const term = BigInt(total - missing) ** length;
    count += bits % 2 ? -term : term;
  }
  return log2BigInt(count);
}

function log2BigInt(value) {
  if (value <= 0n) return 0;
  const digits = value.toString(2).length;
  // Top 52 bits give a precise mantissa; the rest only shift the exponent.
  const shift = Math.max(0, digits - 52);
  return Math.log2(Number(value >> BigInt(shift))) + shift;
}

let wordlist = null;

export async function loadWordlist() {
  if (!wordlist) {
    const text = await fetch(chrome.runtime.getURL("lib/data/eff_large_wordlist.txt")).then((res) => res.text());
    wordlist = text.split("\n").map((word) => word.trim()).filter(Boolean);
  }
  return wordlist;
}

async function generateWords(options) {
  const list = await loadWordlist();
  const words = Array.from({ length: options.words }, () => list[randomIndex(list.length)]);
  const shaped = options.capitalize ? words.map((word) => word[0].toUpperCase() + word.slice(1)) : words;
  // One digit on the end of one random word, for sites that insist on a number.
  if (options.includeNumber) shaped[randomIndex(shaped.length)] += String(randomIndex(10));
  return shaped.join(options.separator);
}

function wordsBits(options, listLength) {
  let bits = options.words * Math.log2(listLength);
  if (options.includeNumber) bits += Math.log2(10) + Math.log2(options.words);
  return bits;
}

/** Generates one password. Returns it with its strength in bits (what an attacker who knows these options must search). */
export async function generatePassword(rawOptions) {
  const options = normalizeGeneratorOptions(rawOptions);
  if (options.type === "words") {
    const password = await generateWords(options);
    return { password, bits: wordsBits(options, (await loadWordlist()).length) };
  }
  return { password: generateChars(options), bits: charsBits(options) };
}

/** "weak" | "fair" | "strong" | "veryStrong" - thresholds for offline guessing of a fast hash. */
export function strengthLevel(bits) {
  if (bits < 50) return "weak";
  if (bits < 70) return "fair";
  if (bits < 100) return "strong";
  return "veryStrong";
}
