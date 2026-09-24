# BrowserSync — how your data is handled

This is a small, informal, self-hosted service, not a commercial product. This
document explains, in plain language, what happens to your data if you use it. If
anything here is unclear, ask whoever gave you the server URL.

## What's stored on the server

- Your **email address** and a **password hash** (not your actual password — it's run
  through a one-way hashing algorithm, argon2id, before it's ever stored).
- A **hash of your recovery passphrase** (not the passphrase itself — same one-way
  hashing, and derived through a completely separate calculation from the one that
  actually protects your data, so this hash can't be used to decrypt anything). It only
  exists so the server can confirm "yes, that's the right recovery passphrase" if you
  ever need to reset a forgotten password.
- Your **wrapped data key**: the actual key that encrypts your bookmarks/history isn't
  your passphrase or your password — it's a random key, generated on your device, that
  gets locked inside an encrypted "envelope" using a key derived from your passphrase.
  That envelope is what's stored here. It's safe to store: opening it requires your
  passphrase, which the server never learns.
- **Encrypted blobs** of your bookmarks, (if you turn it on) browsing history, and
  any passwords you save in the extension's password vault, encrypted on your own device with that data key before they're ever sent anywhere.
- Timestamps of when you last synced, and the rough size of each encrypted blob.
- If you're logged in on more than one device, one row per device recording when it
  last used its login session — this is what lets you log out a single lost/old device
  without logging out everywhere.

## What's NOT stored on the server

- **The actual content of your bookmarks or history, in readable form.** What reaches
  the server is ciphertext — meaningless without the data key described above. Nobody
  can read your bookmark titles, URLs, or browsing history from the server or its
  database — not a hacker who steals the database, and not the admin (see below).
- Your password, in any readable form.
- Your recovery passphrase, in any readable or reversible form.
- A second copy of your data key, wrapped with your password, exists too — but only on
  each of *your own devices* (in the extension's local storage), never on the server.
  That's what lets your password unlock BrowserSync day-to-day without the server ever
  being able to do the same.
- The passwords your browser itself saves, or its autofill data. BrowserSync can't read
  those; it only keeps the passwords you save in its own vault (encrypted, see above).
  If you turn on in-page suggestions, the extension reads a login form's username and
  password when you submit it, only to offer saving them — they stay on your device
  unless you click Save, and are then encrypted before upload like everything else.

## What the admin can and can't see

Whoever runs this server (technically) has normal database access — that's unavoidable
for anyone self-hosting a service. Concretely, that means the admin:

- **Can see:** that an account with your email exists, roughly how large your synced
  data is, and when you last synced.
- **Cannot see:** your bookmarks, your browsing history, or anything else inside your
  encrypted blobs — including with direct access to the database. The admin does see
  your plaintext password at the moment you log in (any password-based login works this
  way), but that alone isn't enough to decrypt your data: the password-wrapped copy of
  your data key lives only on your own devices, never on the server. This is "end-to-end
  encryption": the server is just relaying ciphertext (and an envelope only your
  passphrase can open) that it can't read on its own.

This also means: **if you lose both your password and your recovery passphrase, your
synced data cannot be recovered by anyone, including the admin.** There is no "reset
passphrase" option, by design — a recovery path for the passphrase itself would mean
someone other than you could decrypt your data.

## Backups

The database (including your account, encrypted blobs, and hashed credentials) is
backed up regularly. A backup contains the same information as the live database — it
does not expose your bookmark/history content in plaintext either, since the blobs are
already encrypted before they're stored.

- **Backup frequency:** _[admin: fill in, e.g. "daily at 3am"]_
- **Retention:** _[admin: fill in, e.g. "last 14 daily backups kept"]_
- **Where backups are stored:** _[admin: fill in, e.g. "on the same homelab NAS,
  separate disk from the live database"]_

## Deleting your account

You can delete your account and all data associated with it at any time, from the
extension: open the popup → Settings (⚙) → "Delete account and all synced data". This
immediately and permanently deletes your user record and every encrypted blob tied to
your account from the server (via `DELETE /api/auth/account`) — it cannot be undone,
and there's no way for the admin to recover it afterward either.

## No guarantees

This is a best-effort personal project, not a commercial service:

- There is no SLA. The server can go down for maintenance, a homelab power outage, an
  ISP issue, or any other reason, without notice.
- There is no dedicated support line — this is a service run informally, not a hosted
  product with a support team behind it.

## How long this will run, and who to contact

- **Planned duration:** _[admin: fill in, e.g. "at least through 2027" — set
  expectations so people don't treat this as permanent infrastructure]_
- **Questions or concerns:** _[admin: fill in your contact — email, Matrix/Discord
  handle, etc.]_
