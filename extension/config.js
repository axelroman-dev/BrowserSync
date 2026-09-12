// Single source of truth for the default sync server.
//
// Set to null/empty for now: there is no officially hosted BrowserSync
// server yet, so every install must point at a self-hosted one. When this
// is falsy, the connect screen forces the server-URL field open and
// requires a successful "Test connection" before letting anyone
// register/log in - see connectForm.js.
//
// If an official hosted server is ever stood up, set this to its URL. The
// connect screen automatically switches back to today's behavior (hidden
// by default, used silently unless someone clicks "Using a self-hosted
// server?") with no other code changes needed.
export const OFFICIAL_SERVER_URL = "";

// Public URL for this project's PRIVACY.md, linked from the onboarding
// screen. It has to be an absolute URL, not a relative path into the repo -
// PRIVACY.md lives at the repo root, one level above extension/, so it's
// never packaged inside the extension .zip itself (a relative link like
// "../PRIVACY.md" 404s once installed from the Chrome Web Store). If you
// fork this project and maintain your own privacy policy, change this to
// point at that instead.
export const PRIVACY_POLICY_URL = "https://github.com/axelroman-dev/BrowserSync/blob/main/PRIVACY.md";

// Bump this if the on-disk shape of synced bookmark/history payloads ever
// changes in a way older extension versions can't read.
export const SYNC_PAYLOAD_VERSION = 1;

// Default automatic sync interval, in minutes, used by chrome.alarms.
export const DEFAULT_SYNC_INTERVAL_MINUTES = 15;

// Default history sync window, in days. Configurable per-account later via
// the popup's settings, stored in chrome.storage.local.
export const DEFAULT_HISTORY_DAYS = 90;

// Hard cap mirrored from the server's MAX_BLOB_BYTES default so the
// extension can warn locally before even attempting an upload.
export const MAX_BLOB_BYTES = 5 * 1024 * 1024;
