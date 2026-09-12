// Single source of truth for the default sync server.
//
// This is the ONE line to change if you fork this extension for your own
// self-hosted server: users who never click "Using a self-hosted server?"
// in the connect screen will register/log in against this URL with zero
// configuration on their end.
export const OFFICIAL_SERVER_URL = "https://sync.midominio.com";

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
