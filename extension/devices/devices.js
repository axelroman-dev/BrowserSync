// Lists every device (refresh_tokens row) currently signed into this
// account and lets the user revoke any of them - see server/src/routes/auth.ts
// GET/DELETE /api/auth/devices. Doesn't touch the encrypted sync blobs at
// all, so unlike viewer.js this never needs the DEK/password - only the
// access token, which a logged-in session always has.
import * as auth from "../lib/auth.js";
import { listDevices, revokeDevice, revokeOtherDevices, ApiError, NetworkError } from "../lib/api.js";
import { getAllLocal } from "../lib/storage.js";

const views = {
  notConnected: document.getElementById("not-connected-view"),
  devices: document.getElementById("devices-view"),
};

function showView(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
}

function formatDate(value) {
  if (!value) return "never";
  return new Date(value).toLocaleString();
}

function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function describeError(err) {
  if (err instanceof NetworkError) return "Could not reach the server. Check your connection.";
  if (err instanceof ApiError) return err.message || "The server rejected the request.";
  return err?.message || "Something went wrong.";
}

async function renderDevices() {
  const errorEl = document.getElementById("devices-error");
  errorEl.hidden = true;
  const container = document.getElementById("devices-list");
  const bulkRevokeBtn = document.getElementById("revoke-others-btn");
  clear(container);

  let devices;
  let currentDeviceId;
  try {
    ({ currentDeviceId } = await getAllLocal());
    devices = await listDevices();
    devices.sort((a, b) => new Date(b.lastUsedAt ?? b.createdAt) - new Date(a.lastUsedAt ?? a.createdAt));
    bulkRevokeBtn.hidden = devices.length <= 1;
    if (!devices.length) {
      const empty = document.createElement("p");
      empty.className = "empty-hint";
      empty.textContent = "No linked devices found.";
      container.appendChild(empty);
      return;
    }
    for (const device of devices) {
      container.appendChild(renderDeviceRow(device, device.id === currentDeviceId));
    }
  } catch (err) {
    errorEl.textContent = describeError(err);
    errorEl.hidden = false;
  }
}

// Ghost devices from reinstalling the extension pile up because nothing in
// an extension's own storage survives a full uninstall - there's no
// reliable way to detect "this is the same device as before" and update
// its row instead of creating a new one. This is the one-click cleanup
// instead of revoking a pile of them by hand.
document.getElementById("revoke-others-btn").addEventListener("click", async () => {
  const btn = document.getElementById("revoke-others-btn");
  if (!confirm("Revoke every device except this one? Each one will need to log in again to sync.")) return;
  btn.disabled = true;
  try {
    const { currentDeviceId } = await getAllLocal();
    await revokeOtherDevices(currentDeviceId);
    await renderDevices();
  } catch (err) {
    const errorEl = document.getElementById("devices-error");
    errorEl.textContent = describeError(err);
    errorEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

function renderDeviceRow(device, isCurrent) {
  const row = document.createElement("div");
  row.className = "device-row";

  const info = document.createElement("div");
  info.className = "device-info";

  const label = document.createElement("div");
  label.className = "device-label";
  const labelText = document.createElement("span");
  labelText.textContent = device.deviceLabel || "Unnamed device";
  label.appendChild(labelText);
  if (isCurrent) {
    const badge = document.createElement("span");
    badge.className = "badge-current";
    badge.textContent = "This device";
    label.appendChild(badge);
  } else if (!device.lastUsedAt) {
    // Never refreshed a token since it was created - most likely a
    // reinstall/incomplete setup ghost rather than a device in actual use.
    const badge = document.createElement("span");
    badge.className = "badge-never-used";
    badge.textContent = "Never used";
    label.appendChild(badge);
  }
  info.appendChild(label);

  const meta = document.createElement("div");
  meta.className = "device-meta";
  meta.textContent = `Linked ${formatDate(device.createdAt)} · Last used ${formatDate(device.lastUsedAt)}`;
  info.appendChild(meta);

  row.appendChild(info);

  const revokeBtn = document.createElement("button");
  revokeBtn.className = "revoke-button";
  revokeBtn.textContent = "Revoke";
  revokeBtn.addEventListener("click", async () => {
    const message = isCurrent
      ? "This is the device you're using right now. Revoking it signs it out too. Continue?"
      : `Sign out "${device.deviceLabel || "this device"}"? It will need to log in again to sync.`;
    if (!confirm(message)) return;
    revokeBtn.disabled = true;
    revokeBtn.textContent = "Revoking...";
    try {
      await revokeDevice(device.id);
      await renderDevices();
    } catch (err) {
      const errorEl = document.getElementById("devices-error");
      errorEl.textContent = describeError(err);
      errorEl.hidden = false;
      revokeBtn.disabled = false;
      revokeBtn.textContent = "Revoke";
    }
  });
  row.appendChild(revokeBtn);

  return row;
}

async function init() {
  const session = await auth.getSession();
  if (!session.isLoggedIn) {
    showView("notConnected");
    return;
  }
  document.getElementById("account-label").textContent = `${session.accountEmail} · ${new URL(session.serverUrl).host}`;
  showView("devices");
  await renderDevices();
}

init();
