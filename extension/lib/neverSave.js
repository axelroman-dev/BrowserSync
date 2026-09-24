// Sites where the "Save password?" prompt must never appear, set from that
// prompt's "Never for this site" button and managed from the vault page's
// Settings. Stored per device (chrome.storage.local) by hostname, without
// scheme or port, so "never on localhost" covers every local dev server.
// It only silences the save prompt: saved passwords for these sites are
// still suggested and filled.
import { getAllLocal, setLocal } from "./storage.js";

export async function getNeverSaveHosts() {
  const { passwordNeverSave } = await getAllLocal();
  return Array.isArray(passwordNeverSave) ? passwordNeverSave : [];
}

export async function isNeverSaveHost(hostname) {
  return (await getNeverSaveHosts()).includes(hostname.toLowerCase());
}

export async function addNeverSaveHost(hostname) {
  const hosts = await getNeverSaveHosts();
  const host = hostname.toLowerCase();
  if (!hosts.includes(host)) await setLocal({ passwordNeverSave: [...hosts, host].sort() });
}

export async function removeNeverSaveHost(hostname) {
  const hosts = await getNeverSaveHosts();
  await setLocal({ passwordNeverSave: hosts.filter((host) => host !== hostname) });
}
