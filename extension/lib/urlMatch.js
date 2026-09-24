// Decides whether a saved password belongs to the page the user is on - used
// by lib/pageCredentials.js for suggestions, fills and the save prompt.
// Each vault entry can pick its own mode (entry.match), and entries without
// one follow the device-wide default (passwordMatchDefault in storage.js):
//
//   domain     - same registrable domain: a login saved on example.com is
//                offered on login.example.com too (the default)
//   host       - same host and port only
//   startsWith - the page URL starts with the saved URL
//   exact      - the page URL equals the saved URL (ignoring #fragment)
//
// "Registrable domain" comes from the Public Suffix List bundled in
// lib/data/ (from publicsuffix.org, MPL 2.0). Guessing it instead
// ("the last two labels") would treat alice.github.io and bob.github.io, or
// shop-a.co.uk and shop-b.co.uk, as the same site and offer one's password
// on the other.
export const MATCH_MODES = ["domain", "host", "startsWith", "exact"];
export const DEFAULT_MATCH_MODE = "domain";

let publicSuffixList = null;

/** Loads and parses the bundled list once per service worker / page lifetime. */
export async function loadPublicSuffixList() {
  if (!publicSuffixList) {
    const text = await fetch(chrome.runtime.getURL("lib/data/public_suffix_list.dat")).then((res) => res.text());
    publicSuffixList = parsePublicSuffixList(text);
  }
  return publicSuffixList;
}

/**
 * Rules are listed in Unicode; hostnames from URL are punycode, so
 * non-ASCII rules are converted up front (the URL parser does the
 * conversion). A wildcard rule "*.ck" is kept as "*." + converted rest.
 */
export function parsePublicSuffixList(text) {
  const rules = new Set();
  const exceptions = new Set();
  for (const raw of text.split("\n")) {
    const line = raw.trim().split(/\s/)[0];
    if (!line || line.startsWith("//")) continue;
    const isException = line.startsWith("!");
    const rule = isException ? line.slice(1) : line;
    const wildcard = rule.startsWith("*.");
    const body = wildcard ? rule.slice(2) : rule;
    const ascii = /[^\x00-\x7f]/.test(body) ? toAsciiHostname(body) : body.toLowerCase();
    if (!ascii) continue;
    (isException ? exceptions : rules).add(wildcard ? `*.${ascii}` : ascii);
  }
  return { rules, exceptions };
}

function toAsciiHostname(hostname) {
  try {
    return new URL(`http://${hostname}/`).hostname;
  } catch {
    return null;
  }
}

function isIpAddress(hostname) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[");
}

/**
 * eTLD+1 per the Public Suffix List algorithm: the longest matching rule
 * wins, exception rules ("!www.ck") beat wildcards ("*.ck"), and a name
 * matching no rule falls back to "its TLD is the public suffix". Returns
 * null when the hostname is itself a public suffix (e.g. "github.io").
 * IP addresses and single-label hosts (localhost) are returned as-is.
 */
export function registrableDomain(hostname, psl) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (isIpAddress(host) || !host.includes(".")) return host;
  const labels = host.split(".");
  let suffixLength = 1;
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join(".");
    if (psl.exceptions.has(candidate)) {
      suffixLength = labels.length - i - 1;
      break;
    }
    const parent = labels.slice(i + 1).join(".");
    if (psl.rules.has(candidate) || (parent && psl.rules.has(`*.${parent}`))) {
      suffixLength = labels.length - i;
      break;
    }
  }
  if (labels.length <= suffixLength) return null;
  return labels.slice(-(suffixLength + 1)).join(".");
}

function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

const isWeb = (url) => url.protocol === "https:" || url.protocol === "http:";

function withoutHash(url) {
  const copy = new URL(url.href);
  copy.hash = "";
  return copy.href;
}

/** Whether `entry` (a vault entry) should be offered on `pageUrl`. */
export function entryMatchesUrl(entry, pageUrl, defaultMode, psl) {
  const page = parseUrl(pageUrl);
  const saved = parseUrl(entry.url);
  if (!page || !saved || !isWeb(page) || !isWeb(saved)) return false;
  const mode = MATCH_MODES.includes(entry.match) ? entry.match : defaultMode;

  if (mode === "exact") return withoutHash(saved) === withoutHash(page);
  if (mode === "startsWith") return page.href.startsWith(saved.href);

  // Never offer a password saved on an https site to its plain-http
  // version, where anyone on the network could read it back. The other
  // way round (saved on http, now on https) is fine.
  if (saved.protocol === "https:" && page.protocol !== "https:") return false;
  if (mode === "host") return saved.host === page.host;

  const savedDomain = registrableDomain(saved.hostname, psl);
  const pageDomain = registrableDomain(page.hostname, psl);
  if (!savedDomain || !pageDomain) return saved.hostname === page.hostname;
  return savedDomain === pageDomain;
}
