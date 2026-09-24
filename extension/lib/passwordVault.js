// Saved-password vault. Unlike bookmarks/history there's no Chromium store
// to read from or write back to (extensions have no API for the browser's
// own saved passwords), so the vault is its own list of entries:
//
//   { id, url, origin, username, password, notes, match, favicon, createdAt, updatedAt }
//
// (`match` is the entry's URL-matching mode, or null to follow the device
// default - see urlMatch.js. `favicon` is a small data: URL of the site's
// icon, or null - see favicon.js.)
//
// kept in chrome.storage.local encrypted with the DEK (see storage.js) and
// synced as the "passwords" blob. Losing an edit here is far worse than
// losing a bookmark move, so merging is per ENTRY rather than whole-blob:
// every entry has its own updatedAt (last write wins), and a deletion
// leaves a small tombstone ({ id, deleted: true, updatedAt } - no username
// or password kept) so another device's older copy can't resurrect it.
//
// Every read-modify-write of the local vault runs under one Web Lock,
// shared by the vault page and the service worker (same extension origin),
// so a background sync can't overwrite an entry the user is saving at the
// same moment.
import { SYNC_PAYLOAD_VERSION } from "../config.js";
import { getAllLocal, setLocal } from "./storage.js";
import { encryptJSON, decryptJSON } from "./crypto.js";
import { getSyncBlob, putSyncBlob } from "./api.js";
import { MATCH_MODES } from "./urlMatch.js";
import { fetchFavicon } from "./favicon.js";
import { t } from "./i18n.js";

const LOCK_NAME = "browsersync-password-vault";
// Tombstones only need to outlive the longest a device plausibly stays
// offline; after that they're pruned so the blob doesn't grow forever. A
// device offline for longer than this could bring a deleted entry back.
const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_CONFLICT_RETRIES = 3;

function withVaultLock(fn) {
  return navigator.locks.request(LOCK_NAME, fn);
}

function decryptFailed() {
  return Object.assign(new Error(t("errors.decryptFailedPasswords")), { code: "decrypt_failed" });
}

async function readLocalEntries(key) {
  const { passwordVault } = await getAllLocal();
  if (!passwordVault) return [];
  try {
    const payload = await decryptJSON(key, passwordVault.ciphertext, passwordVault.iv);
    return payload.entries ?? [];
  } catch {
    throw decryptFailed();
  }
}

async function writeLocalEntries(key, entries, extra = {}) {
  const passwordVault = await encryptJSON(key, { version: SYNC_PAYLOAD_VERSION, entries });
  await setLocal({ passwordVault, ...extra });
}

/**
 * Accepts what a user would type ("github.com", "https://github.com/login")
 * and returns the full URL plus its origin - the origin is what future
 * credential suggestions will match on, exactly (scheme + host + port), so
 * a saved github.com login is never offered on github.com.evil.example.
 * Non-web URLs (e.g. Chrome's "android://" CSV rows) keep origin null.
 */
export function normalizeUrl(input) {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return { url: "", origin: null };
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    const isWeb = parsed.protocol === "https:" || parsed.protocol === "http:";
    return { url: parsed.href, origin: isWeb ? parsed.origin : null };
  } catch {
    return { url: trimmed, origin: null };
  }
}

/** Per-entry last-write-wins merge by id; a tombstone beats a live entry on a timestamp tie. */
export function mergeEntries(a, b) {
  const byId = new Map();
  for (const entry of [...a, ...b]) {
    const existing = byId.get(entry.id);
    if (
      !existing ||
      entry.updatedAt > existing.updatedAt ||
      (entry.updatedAt === existing.updatedAt && entry.deleted && !existing.deleted)
    ) {
      byId.set(entry.id, entry);
    }
  }
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  return [...byId.values()].filter((entry) => !(entry.deleted && entry.updatedAt < cutoff));
}

/** Live (non-deleted) entries, sorted for display. */
export async function listEntries(key) {
  const entries = await readLocalEntries(key);
  return entries
    .filter((entry) => !entry.deleted)
    .sort((x, y) => (x.origin ?? x.url).localeCompare(y.origin ?? y.url) || x.username.localeCompare(y.username));
}

/**
 * Creates (no `id`) or updates (with `id`) one entry. `faviconPageUrl` is
 * the page to take the icon from when it isn't `url` itself - the browser
 * caches icons per visited page, and the login page is the one known to
 * have been visited.
 */
export async function saveEntry(key, { id, url, username, password, notes, match, faviconPageUrl }) {
  // Read before taking the lock: it's only a local cache lookup, but other
  // vault writers needn't wait on it. Only real saves refresh the icon -
  // never a background pass, whose bumped updatedAt could win the per-entry
  // merge over a newer edit made on another device.
  const favicon = (faviconPageUrl && (await fetchFavicon(faviconPageUrl))) || (await fetchFavicon(normalizeUrl(url).url));
  return withVaultLock(async () => {
    const entries = await readLocalEntries(key);
    const now = Date.now();
    const fields = {
      ...normalizeUrl(url),
      username: username ?? "",
      password: password ?? "",
      notes: notes ?? "",
      match: MATCH_MODES.includes(match) ? match : null,
    };
    const index = id ? entries.findIndex((entry) => entry.id === id && !entry.deleted) : -1;
    if (index >= 0) {
      const existing = entries[index];
      // No icon in the cache right now: keep the one already stored, unless
      // the entry moved to a different site.
      const keptFavicon = existing.url === fields.url ? (existing.favicon ?? null) : null;
      entries[index] = { ...existing, ...fields, favicon: favicon ?? keptFavicon, updatedAt: now };
    } else {
      entries.push({ id: crypto.randomUUID(), ...fields, favicon, createdAt: now, updatedAt: now });
    }
    await writeLocalEntries(key, entries, { passwordsPendingSync: true });
  });
}

export async function deleteEntry(key, id) {
  return withVaultLock(async () => {
    const entries = await readLocalEntries(key);
    const index = entries.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    entries[index] = { id, deleted: true, updatedAt: Date.now() };
    await writeLocalEntries(key, entries, { passwordsPendingSync: true });
  });
}

/**
 * Adds rows from parseCsv(), skipping any that exactly match an existing
 * entry (same site, username and password) so importing the same export
 * twice is harmless.
 */
export async function importEntries(key, rows) {
  const favicons = await Promise.all(rows.map((row) => fetchFavicon(normalizeUrl(row.url).url)));
  return withVaultLock(async () => {
    const entries = await readLocalEntries(key);
    const signature = (entry) => `${entry.origin ?? entry.url}\n${entry.username}\n${entry.password}`;
    const existing = new Set(entries.filter((entry) => !entry.deleted).map(signature));
    const now = Date.now();
    let added = 0;
    for (const [i, row] of rows.entries()) {
      const entry = {
        id: crypto.randomUUID(),
        ...normalizeUrl(row.url),
        username: row.username ?? "",
        password: row.password ?? "",
        notes: row.notes ?? "",
        favicon: favicons[i],
        createdAt: now,
        updatedAt: now,
      };
      if (!entry.password || existing.has(signature(entry))) continue;
      existing.add(signature(entry));
      entries.push(entry);
      added++;
    }
    if (added) await writeLocalEntries(key, entries, { passwordsPendingSync: true });
    return { added, skipped: rows.length - added };
  });
}

/**
 * Parses a password CSV export. Columns are found by header name, which
 * covers Chrome/Edge/Brave (name,url,username,password,note), Firefox
 * (url,username,password,...) and Bitwarden (login_uri,login_username,
 * login_password,notes) exports alike. Handles quoted fields with commas,
 * doubled quotes and line breaks.
 */
export function parseCsv(text) {
  const records = [];
  let record = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || record.length) {
    record.push(field);
    records.push(record);
  }

  const [header, ...rows] = records.filter((r) => r.some((value) => value.trim()));
  if (!header) return null;
  const names = header.map((name) => name.trim().toLowerCase().replace(/^﻿/, ""));
  const column = (...candidates) => names.findIndex((name) => candidates.includes(name));
  const urlCol = column("url", "login_uri", "website", "origin");
  const userCol = column("username", "login_username", "user", "email");
  const passCol = column("password", "login_password");
  const notesCol = column("note", "notes", "comment");
  if (urlCol < 0 || passCol < 0) return null;

  return rows.map((row) => ({
    url: row[urlCol] ?? "",
    username: userCol >= 0 ? (row[userCol] ?? "") : "",
    password: row[passCol] ?? "",
    notes: notesCol >= 0 ? (row[notesCol] ?? "") : "",
  }));
}

/**
 * Pulls the remote vault, merges it with the local one, and pushes the
 * result back - retrying the merge if another device wrote in between (the
 * server's version check, see syncService.ts). Holds the vault lock for the
 * whole round trip so no local edit can land between the merge and the
 * local write.
 */
export async function syncPasswords(key) {
  return withVaultLock(async () => {
    try {
      const localEntries = await readLocalEntries(key);
      const remoteBlob = await getSyncBlob("passwords");

      let merged = localEntries;
      let expectedVersion = 0;
      if (remoteBlob) {
        merged = mergeEntries(localEntries, await decryptRemote(key, remoteBlob));
        expectedVersion = remoteBlob.version;
      }

      for (let attempt = 0; ; attempt++) {
        const { ciphertext, iv } = await encryptJSON(key, { version: SYNC_PAYLOAD_VERSION, entries: merged });
        const result = await putSyncBlob("passwords", {
          ciphertext,
          iv,
          clientUpdatedAt: new Date().toISOString(),
          expectedVersion,
        });
        if (!result.conflict) {
          await writeLocalEntries(key, merged, {
            passwordsBlobVersion: result.version,
            passwordsPendingSync: false,
            passwordsSyncError: null,
          });
          return { entryCount: merged.filter((entry) => !entry.deleted).length };
        }
        if (attempt >= MAX_CONFLICT_RETRIES) throw new Error(t("errors.passwordsSyncConflict"));
        merged = mergeEntries(merged, await decryptRemote(key, result.conflict));
        expectedVersion = result.conflict.version;
      }
    } catch (err) {
      // A server from before the vault existed has no /api/sync/passwords
      // route and answers with Express's plain-HTML 404.
      const error = err?.status === 404 ? new Error(t("errors.passwordsServerOutdated")) : err;
      await setLocal({ passwordsSyncError: error?.message || t("common.somethingWentWrong") });
      throw error;
    }
  });
}

async function decryptRemote(key, blob) {
  try {
    const payload = await decryptJSON(key, blob.ciphertext, blob.iv);
    return payload.entries ?? [];
  } catch {
    throw decryptFailed();
  }
}
