# BrowserSync

A self-hosted bookmark/history sync system for any Chromium-based browser — Manifest V3
extensions work the same way across all of them. It's aimed at two kinds of people:

- Anyone on a Chromium fork that has no Chrome Sync at all, because Google restricted
  those APIs to official Chrome builds in 2021 (e.g.
  [Helium](https://github.com/imputnet/helium-chromium), ungoogled-chromium, and
  similar).
- Anyone on Chrome, Brave, Edge, or another Chromium browser that *does* have its own
  sync, but who'd rather self-host their own bookmark/history data than trust it to
  Google/Microsoft/Brave's servers.

Two parts:

- **`extension/`** — a Manifest V3 browser extension. Encrypts your data client-side
  before it ever leaves your device.
- **`server/`** — a self-hosted, multi-user backend (Node.js + Express + PostgreSQL)
  that stores and relays encrypted blobs. It never sees your data in plaintext.

See [`PRIVACY.md`](PRIVACY.md) for what's stored and what isn't.

---

## For the administrator

This is the part you (whoever runs the server) need. The people who use your server
only need the ["For users"](#for-users) section below.

### Running the server

Requirements: Docker and Docker Compose.

```bash
cd server
cp .env.example .env
```

Edit `.env`:
- Set `JWT_SECRET` to a long random value:
  `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
- Set `POSTGRES_PASSWORD` (referenced by `docker-compose.yml`) to something real —
  add it to `.env` as `POSTGRES_PASSWORD=...`.
- Leave `ALLOW_REGISTRATION=true` while accounts are still being created.

Then:

```bash
docker compose up -d --build
curl http://localhost:3000/api/health   # should return {"status":"ok"}
```

This starts Postgres and the API, and runs database migrations automatically on
startup (including on every restart — already-applied migrations are skipped).

### Closing registration

Once everyone who needs an account has one, stop new signups without touching code:

```bash
# in .env
ALLOW_REGISTRATION=false
```

```bash
docker compose up -d
```

### Exposing it outside your homelab

The app only binds to `127.0.0.1:3000` on the host by default — it isn't reachable
from your LAN or the internet until you put something in front of it. Three options,
roughly in order of "least effort" to "most control":

| Option | Effort | Trade-offs |
|---|---|---|
| **Tailscale** | Low | Every user installs Tailscale and joins your tailnet; the extension points at your machine's Tailscale IP/hostname. No public exposure at all, but every device needs Tailscale installed and running. |
| **Cloudflare Tunnel** | Medium | `cloudflared` on your homelab machine exposes the app at a public subdomain with TLS handled by Cloudflare, no port forwarding needed. Public URL means normal internet-facing exposure/abuse surface (mitigated by the rate limiting already built in), and you're depending on Cloudflare's availability. |
| **Nginx + Let's Encrypt** | Higher | Full control, standard TLS-terminated reverse proxy on a port-forwarded connection. You're responsible for renewals (certbot automates this) and for hardening Nginx yourself (fail2ban, etc.) since you're now directly internet-facing. |

Whichever you choose, put the reverse proxy in front of port 3000 and give your users
the resulting HTTPS URL (e.g. `https://sync.yourdomain.com`) — that's what goes in the
extension's "self-hosted server" field, and what you should hardcode as
`OFFICIAL_SERVER_URL` in `extension/config.js` before distributing the extension.

### Backups

```bash
cd server
./scripts/backup.sh
```

Dumps the database (via `pg_dump` inside the running `db` container) to
`server/backups/`, gzip-compressed, and deletes dumps older than 14 days (both
configurable via `BROWSERSYNC_BACKUP_DIR` / `BROWSERSYNC_BACKUP_RETENTION_DAYS` env
vars). Automate it with cron:

```bash
crontab -e
# add:
0 3 * * * cd /path/to/BrowserSync/server && ./scripts/backup.sh >> /var/log/browsersync-backup.log 2>&1
```

Fill in your actual backup schedule/retention/location in [`PRIVACY.md`](PRIVACY.md) so
your users know what to expect.

### Restoring from a backup

```bash
gunzip -c server/backups/browsersync_TIMESTAMP.sql.gz | docker compose exec -T db psql -U browsersync -d browsersync
```

### Forking for your own server

The whole point of the "self-hosted server" field in the extension is that anyone can
point it at their own instance. If you're forking this extension for your own use:

1. Change `OFFICIAL_SERVER_URL` in `extension/config.js` to your server's URL.
2. That's it — everything else (icons, name, etc.) is optional cosmetic change.

### Distributing the extension to your users

There's no Chrome Web Store listing (this isn't going through Google review, and on
forks without Chrome Sync there's no first-party alternative to publish it as anyway).
Users load it unpacked — see the user section below. Share the `extension/` folder
with them (a zip, a shared network drive, a release on your repo, or a git clone) plus
a link to [`PRIVACY.md`](PRIVACY.md).

---

## For users

These steps get BrowserSync running in your browser so your bookmarks follow you
between your devices. It works the same way in any Chromium-based browser — Helium,
ungoogled-chromium, Chrome, Brave, Edge, and so on.

### 1. Install the extension

1. Get the `extension` folder from whoever set up the server you'll be using (or
   from this repo, if you're setting it up yourself).
2. Open your browser and go to `chrome://extensions` (same address in every
   Chromium-based browser).
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `extension` folder.
5. A "BrowserSync" icon appears in your toolbar, and a new tab opens asking you to
   connect.

### 2. Create your account

On the tab that opened (or any time later, by clicking the toolbar icon):

1. Enter your **email** and choose a **password**, then click **Create account**.
   That's it for this screen — you do **not** need to touch the server URL, it's
   already pointed at the default server (only click "Using a self-hosted server?" if
   you were specifically told to point at a different one).
2. Right after that, BrowserSync shows you a **recovery passphrase** it generated for
   you. **Save it somewhere safe right now** — a password manager like Bitwarden,
   1Password, or KeePass. This passphrase is the only way to connect a second device or
   reset your password later if you forget it. It's never sent anywhere in a form that
   would let the server (or its admin) read your data — that's what keeps your
   bookmarks private. There is no "forgot passphrase" option: if you lose both your
   password and this passphrase, nobody can recover your synced data.
3. Check the confirmation box and click **Continue**.

### 3. Using it day to day

- BrowserSync syncs automatically in the background (every 15 minutes by default).
- Click the toolbar icon any time to see your last sync status, or hit **Sync now** for
  an immediate sync.
- To sync bookmarks to a second device: install the extension there, choose **"Already
  have an account? Log in"**, and enter the same email and password. Since this is a
  new device, it'll ask for your **recovery passphrase once** to finish connecting —
  after that, your password alone unlocks BrowserSync on that device.
- If you restart your browser, the popup will ask you to re-enter your **password**
  once to resume syncing — your login stays intact, this just re-derives the local
  encryption key, which is deliberately never written to disk. This never requires the
  recovery passphrase unless the device's local setup gets lost somehow, in which case
  the popup will guide you through reconnecting it (password + passphrase again).
- Forgot your password? Click "Forgot your password?" on the login screen and use your
  recovery passphrase to set a new one.
- Browsing history sync is off by default. Turn it on in the popup's settings (⚙) if
  you want it, and set how many days of history to keep synced.
- Click **"View synced data"** in the popup to open a page showing exactly what's
  currently stored on the server for your account — your bookmark tree, your synced
  history (searchable), and the last-synced list of installed extensions — decrypted
  locally, right there in the page. It's a good way to confirm a sync actually went
  through, or to check what another of your devices has synced without switching to it.

### 4. Your data, and how to delete it

Read [`PRIVACY.md`](PRIVACY.md) — it explains, in plain language, exactly what's
stored, what the admin can and can't see, and how to permanently delete your account
and all your synced data whenever you want (popup → ⚙ → "Delete account and all synced
data").

### Personal vs. work profile

If you use separate browser profiles for personal and work, install the extension in
each profile independently — each one keeps its own server URL, account, and sync
state, so you can point them at different servers or use different accounts without
them interfering with each other.
