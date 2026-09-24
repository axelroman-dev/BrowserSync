// Export/import: passwords as CSV (to move them to another password
// manager or browser) and a full backup file encrypted with a password the
// user picks (to restore into this or another account/server). Every
// export first re-checks the account password - see auth.verifyPassword.
//
// Backup file format (JSON):
//   { format: "browsersync-backup", version: 1, createdAt,
//     kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt },
//     iv, ciphertext }
// where ciphertext is AES-GCM over { passwords, bookmarks, settings }. The
// key comes from the backup password with a random salt, not from the
// account's DEK, so the file can be restored into a different account or
// server - and it stays opaque to whoever holds the file without that
// password.
import { pbkdf2DeriveKey, encryptJSON, decryptJSON, bufferToBase64, base64ToBuffer } from "./crypto.js";
import { listEntries, importEntries } from "./passwordVault.js";
import { MATCH_MODES } from "./urlMatch.js";
import { getAllLocal, setLocal } from "./storage.js";
import { t } from "./i18n.js";

const FORMAT = "browsersync-backup";
const FORMAT_VERSION = 1;
const PBKDF2_ITERATIONS = 600_000;
export const MIN_BACKUP_PASSWORD_LENGTH = 8;
const SETTINGS_KEYS = ["historyEnabled", "historyDays", "syncIntervalMinutes", "passwordMatchDefault", "language"];

const clampInt = (value, min, max) => (Number.isInteger(value) && value >= min && value <= max ? value : undefined);

// A backup file is outside input: only well-typed, in-range values are
// applied, anything else keeps this device's current setting.
const SETTING_VALIDATORS = {
  historyEnabled: (value) => (typeof value === "boolean" ? value : undefined),
  historyDays: (value) => clampInt(value, 1, 3650),
  syncIntervalMinutes: (value) => clampInt(value, 5, 1440),
  passwordMatchDefault: (value) => (MATCH_MODES.includes(value) ? value : undefined),
  language: (value) => (["auto", "en", "es"].includes(value) ? value : undefined),
};

// ---- CSV -------------------------------------------------------------------

function csvField(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Chrome's own export columns, which Chrome, Edge, Firefox, Bitwarden and this vault's importer all read. */
export function entriesToCsv(entries) {
  const lines = [["name", "url", "username", "password", "note"].join(",")];
  for (const entry of entries) {
    let name = entry.url;
    try {
      name = new URL(entry.url).hostname;
    } catch {
      // Non-web URL (e.g. android://) - keep it as the name.
    }
    lines.push([name, entry.url, entry.username, entry.password, entry.notes].map(csvField).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

// ---- Downloads -------------------------------------------------------------

export function downloadFile(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function datedFilename(prefix, extension) {
  return `${prefix}-${new Date().toISOString().slice(0, 10)}.${extension}`;
}

// ---- Full backup -------------------------------------------------------------

/** Bookmarks as a plain {title, url?, children?} tree, without Chrome's node ids. */
function simplifyBookmarks(nodes) {
  return nodes.map((node) =>
    node.url ? { title: node.title, url: node.url } : { title: node.title, children: simplifyBookmarks(node.children ?? []) },
  );
}

/** Gathers the chosen parts: `include` is { passwords, bookmarks, settings }. */
export async function collectBackup(key, include) {
  const data = {};
  if (include.passwords) {
    data.passwords = (await listEntries(key)).map(({ url, username, password, notes, match, favicon }) => ({
      url,
      username,
      password,
      notes,
      match,
      favicon,
    }));
  }
  if (include.bookmarks) {
    const [root] = await chrome.bookmarks.getTree();
    // The root's children are the fixed top-level folders (bookmarks bar,
    // other bookmarks, mobile); keep them as named folders.
    data.bookmarks = simplifyBookmarks(root.children ?? []);
  }
  if (include.settings) {
    const local = await getAllLocal();
    data.settings = Object.fromEntries(SETTINGS_KEYS.map((name) => [name, local[name]]));
  }
  return data;
}

export async function encryptBackup(data, backupPassword) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await pbkdf2DeriveKey(backupPassword, salt);
  const { ciphertext, iv } = await encryptJSON(key, data);
  return JSON.stringify(
    {
      format: FORMAT,
      version: FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      kdf: { name: "PBKDF2", hash: "SHA-256", iterations: PBKDF2_ITERATIONS, salt: bufferToBase64(salt) },
      iv,
      ciphertext,
    },
    null,
    2,
  );
}

/** Throws a readable error for anything that isn't a backup this version can open, or a wrong password. */
export async function decryptBackup(fileText, backupPassword) {
  let file;
  try {
    file = JSON.parse(fileText);
  } catch {
    throw new Error(t("backup.notABackup"));
  }
  if (file?.format !== FORMAT || !file.kdf?.salt || !file.iv || !file.ciphertext) throw new Error(t("backup.notABackup"));
  if (file.version > FORMAT_VERSION || file.kdf.iterations !== PBKDF2_ITERATIONS) throw new Error(t("backup.newerFormat"));
  const key = await pbkdf2DeriveKey(backupPassword, new Uint8Array(base64ToBuffer(file.kdf.salt)));
  try {
    return { createdAt: file.createdAt, data: await decryptJSON(key, file.ciphertext, file.iv) };
  } catch {
    throw new Error(t("backup.wrongBackupPassword"));
  }
}

const countBookmarks = (nodes) => (nodes ?? []).reduce((sum, node) => sum + (node.url ? 1 : countBookmarks(node.children)), 0);

/** Counts per part, for the "this file contains…" summary before restoring. */
export function describeBackup(data) {
  return {
    passwords: Array.isArray(data.passwords) ? data.passwords.length : null,
    bookmarks: Array.isArray(data.bookmarks) ? countBookmarks(data.bookmarks) : null,
    settings: data.settings && typeof data.settings === "object" ? true : null,
  };
}

/**
 * Bookmarks are restored into one new folder under "Other bookmarks" instead
 * of merged into the existing ones: nothing already here is touched, and
 * the next sync uploads the restored folder like any other change.
 */
async function restoreBookmarks(nodes) {
  const [root] = await chrome.bookmarks.getTree();
  const otherBookmarks = root.children?.[1] ?? root.children?.[0];
  const folder = await chrome.bookmarks.create({
    parentId: otherBookmarks.id,
    title: t("backup.restoredFolder", { date: new Date().toLocaleDateString() }),
  });
  let created = 0;
  let failed = 0;
  async function createAll(parentId, children) {
    for (const node of children ?? []) {
      try {
        if (node.url) {
          await chrome.bookmarks.create({ parentId, title: node.title ?? "", url: node.url });
          created++;
        } else if (countBookmarks(node.children)) {
          // Empty folders (an unused "Mobile bookmarks", say) aren't worth recreating.
          const sub = await chrome.bookmarks.create({ parentId, title: node.title ?? "" });
          await createAll(sub.id, node.children);
        }
      } catch {
        // e.g. a URL scheme Chrome refuses (javascript:, chrome://) - skip it.
        failed++;
      }
    }
  }
  await createAll(folder.id, nodes);
  return { created, failed };
}

/** Restores the chosen parts: `include` is { passwords, bookmarks, settings }. */
export async function restoreBackup(key, data, include) {
  const result = {};
  if (include.passwords && Array.isArray(data.passwords)) {
    result.passwords = await importEntries(key, data.passwords);
  }
  if (include.bookmarks && Array.isArray(data.bookmarks)) {
    result.bookmarks = await restoreBookmarks(data.bookmarks);
  }
  if (include.settings && data.settings) {
    const settings = {};
    for (const name of SETTINGS_KEYS) {
      const value = SETTING_VALIDATORS[name](data.settings[name]);
      if (value !== undefined) settings[name] = value;
    }
    await setLocal(settings);
    result.settings = true;
  }
  return result;
}
