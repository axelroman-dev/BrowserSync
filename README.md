# BrowserSync

A self-hosted bookmark/history sync system for any Chromium-based browser and for
Firefox — one Manifest V3 extension, built for both, against the same server. It's
aimed at two kinds of people:

- Anyone on a Chromium fork that has no Chrome Sync at all, because Google restricted
  those APIs to official Chrome builds in 2021 (e.g.
  [Helium](https://github.com/imputnet/helium-chromium), ungoogled-chromium, and
  similar).
- Anyone on Chrome, Brave, Edge, or another Chromium browser that *does* have its own
  sync, but who'd rather self-host their own bookmark/history data than trust it to
  Google/Microsoft/Brave's servers.
- Anyone who uses Firefox next to a Chromium browser and wants the same bookmarks,
  history and passwords in both, which neither browser's own sync can do.

Two parts:

- **`extension/`** — a Manifest V3 browser extension. Encrypts your data client-side
  before it ever leaves your device.
- **`server/`** — a self-hosted, multi-user backend (Node.js + Express + PostgreSQL)
  that stores and relays encrypted blobs. It never sees your data in plaintext.

Get the extension:

- **Chrome / Chromium browsers:** [Chrome Web Store](https://chromewebstore.google.com/detail/browsersync-self-hosted/maihfciicepeinnpcdoiafijgghcfeme)
- **Firefox:** [Firefox Add-ons (AMO)](https://addons.mozilla.org/en-US/firefox/addon/browsersync-self-hosted/)

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
curl http://localhost:3000/api/health   # should return {"status":"ok","service":"browsersync","version":"…","apiVersion":1,"minApiVersion":1}
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

### Hiding the landing page

By default `/` shows a public page explaining what BrowserSync is, with links to the
extension stores. If you'd rather not advertise it, turn it off:

```bash
# in .env
SHOW_LANDING=false
```

`/` then redirects straight to the account dashboard (`/dashboard/`). The API and the
dashboard work the same either way. Restart with `docker compose up -d` to apply.

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

**Upload size:** synced data is uploaded in one request per kind (history is usually
the biggest), up to `MAX_BLOB_BYTES` (5 MB by default). nginx rejects request bodies
over 1 MB by default, which shows up in the extension as a failed sync (HTTP 413), so
raise the limit in the server block:

```nginx
client_max_body_size 10m;
```

In Nginx Proxy Manager, put that line in the proxy host's **Advanced** tab.

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

### Publishing the server image automatically (optional)

If you'd rather pull a pre-built image on your homelab than `git clone` and
`docker compose up --build` there every time,
[`.github/workflows/publish-server.yml`](.github/workflows/publish-server.yml) builds and
pushes a multi-architecture image (amd64 + arm64) to Docker Hub **only when the server
is released** (see [Releasing a new version](#releasing-a-new-version)), or on demand
from the Actions tab to republish an existing version. Pushes to `main` and pull
requests never publish: [CI](.github/workflows/ci.yml) builds the image on them without
pushing it, so a broken Dockerfile still fails the PR.

To enable it:

1. Create a Docker Hub [access token](https://hub.docker.com/settings/security) (not
   your account password) with **Read & Write**, for pushing images.
2. Optionally, a second token with **Read, Write, Delete**, which Docker Hub requires
   only to update the repo's "Overview" tab.
3. In your GitHub repo, add these secrets under **Settings → Secrets and variables →
   Actions**: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` and, if you made it,
   `DOCKERHUB_DESCRIPTION_TOKEN`.

Each server release publishes `axelromandev/browsersync-server` tagged `X.Y.Z`, `X.Y`,
`latest` and the short commit SHA, and syncs the Docker Hub "Overview" tab from
[`server/DOCKERHUB.md`](server/DOCKERHUB.md) - edit that file (not Docker Hub's web UI)
to change the description shown there.

Then on your homelab, point `docker-compose.yml`'s `app` service at the published image
instead of building locally:

```yaml
app:
  image: axelromandev/browsersync-server:latest # instead of "build: ."
```

```bash
docker compose pull && docker compose up -d
```

Consider pinning to a specific tag (a version or commit SHA) rather than `latest` in
production, so a bad push doesn't silently roll out to your homelab on the next
`docker compose pull` - bump it deliberately when you're ready.

### Releasing a new version

Versions are handled by [release-please](https://github.com/googleapis/release-please)
([`.github/workflows/release.yml`](.github/workflows/release.yml)). The extension and
the server are versioned **separately**: each has its own version, its own changelog
([`extension/CHANGELOG.md`](extension/CHANGELOG.md),
[`server/CHANGELOG.md`](server/CHANGELOG.md)) and its own tags (`extension-vX.Y.Z`,
`server-vX.Y.Z`), so a server-only fix doesn't bump the extension in the store.
Releases up to 2.4.2 shared one version; their history is in [`CHANGELOG.md`](CHANGELOG.md).

Write commit messages (or PR titles, when squash-merging) as
[conventional commits](https://www.conventionalcommits.org/): `feat: ...` for new
features, `fix: ...` for bug fixes, `feat!: ...` for breaking changes. A commit counts
for whichever of `extension/` and `server/` it touches. On every push to `main`,
release-please keeps one **release** pull request up to date that bumps the versions
(`extension/manifest.json`, `server/package.json`, `server/package-lock.json`) and the
changelogs. Merge it when you want to release: it creates the tags and GitHub releases,
publishes the server image if the server was released, and attaches the extension ZIPs
for Chromium and Firefox to the extension's release. Never edit those version fields by
hand. Publishing the Firefox one is manual: upload
`browsersync-extension-firefox-X.Y.Z.zip` from that release to
[AMO](https://addons.mozilla.org/developers/) as a new version, with its release notes.

Both builds come from the same `extension/` folder:
`node scripts/build-extension.mjs chrome|firefox` writes `dist/chrome/` or
`dist/firefox/` (the Firefox one only differs in its manifest - see the script).
`extension/` itself stays loadable unpacked in Chromium as-is.

Every PR runs [CI](.github/workflows/ci.yml), and `main` only accepts a merge once its
`ci-ok` check passes. [Dependabot](.github/dependabot.yml) opens weekly PRs for npm
packages, the Node base image (pinned by digest in `server/Dockerfile`) and the
GitHub Actions. The Node major lives in [`server/.node-version`](server/.node-version),
and CI fails if the Dockerfile uses a different one.

One-time setup - release-please runs as a GitHub App, because pull requests and tags
created with the default `GITHUB_TOKEN` don't trigger CI:

1. Create a GitHub App (**Settings → Developer settings → GitHub Apps → New GitHub
   App**) with webhooks off and these repository permissions: **Contents: Read and
   write**, **Pull requests: Read and write**. Install it on this repository only.
2. Generate a private key for it.
3. In this repo, under **Settings → Secrets and variables → Actions**, add the App's
   Client ID as the **variable** `RELEASE_APP_CLIENT_ID` and the private key as the
   **secret** `RELEASE_APP_PRIVATE_KEY`.

### Forking for your own server

The whole point of the "self-hosted server" field in the extension is that anyone can
point it at their own instance. If you're forking this extension for your own use:

1. Change `OFFICIAL_SERVER_URL` in `extension/config.js` to your server's URL.
2. That's it — everything else (icons, name, etc.) is optional cosmetic change.

### Distributing the extension to your users

The extension is published on the [Chrome Web Store](https://chromewebstore.google.com/detail/browsersync-self-hosted/maihfciicepeinnpcdoiafijgghcfeme) (for any
Chromium-based browser) and on [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/browsersync-self-hosted/). Point your users at those
and give them your server URL, plus a link to [`PRIVACY.md`](PRIVACY.md).

If you fork it, those listings won't carry your changes: Chromium users can load your
`extension/` folder unpacked (see the user section below), but Firefox only runs add-ons
Mozilla has signed, so you need your own AMO listing and add-on ID - `GECKO_ID` in
[`scripts/build-extension.mjs`](scripts/build-extension.mjs).

---

## For users

These steps get BrowserSync running in your browser so your bookmarks follow you
between your devices. It works the same way in any Chromium-based browser — Helium,
ungoogled-chromium, Chrome, Brave, Edge, and so on — and in Firefox (140 or newer),
all with the same account.

### 1. Install the extension

**Chrome, Brave, Edge, Helium and other Chromium-based browsers:** install BrowserSync
from the [Chrome Web Store](https://chromewebstore.google.com/detail/browsersync-self-hosted/maihfciicepeinnpcdoiafijgghcfeme) and skip to step 2.

**Firefox:** install BrowserSync from [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/browsersync-self-hosted/) and skip to step 2.

**Unpacked (a fork, or a version not in the store yet):**

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

1. The first screen asks for the **server URL** — there's no officially hosted
   BrowserSync server (yet), so enter the one whoever set up your server gave you and
   click **Test connection**. The login/register form only appears once the server
   responds (you can go back with **Change** next to the server name).
2. Enter your **email**, choose a **password**, and click **Create account**.
3. Right after that, BrowserSync shows you a **recovery passphrase** it generated for
   you. **Save it somewhere safe right now** — a password manager like Bitwarden,
   1Password, or KeePass. This passphrase is the only way to connect a second device or
   reset your password later if you forget it. It's never sent anywhere in a form that
   would let the server (or its admin) read your data — that's what keeps your
   bookmarks private. There is no "forgot passphrase" option: if you lose both your
   password and this passphrase, nobody can recover your synced data.
4. Check the confirmation box and click **Continue**.

### 3. Using it day to day

- BrowserSync syncs automatically in the background (every 15 minutes by default).
- Click the toolbar icon any time to see your last sync status, or hit **Sync now** for
  an immediate sync.
- To sync bookmarks to a second device: install the extension there, enter the **same
  server URL** and test the connection, choose **"Already have an account? Log in"**,
  and enter the same email and password. Since this is a new device, it'll ask for your
  **recovery passphrase once** to finish connecting — after that, your password alone
  unlocks BrowserSync on that device.
- **Firefox and Chromium on the same account:** Firefox has one extra top-level
  folder, the **Bookmarks Menu**; in Chromium it shows up as a "Bookmarks Menu" folder
  inside "Other bookmarks", and anything you put there appears in Firefox's menu.
  Firefox separators and smart folders ("Most Visited", `place:` URLs) aren't synced -
  they stay in that Firefox only.
- If you restart your browser, the popup will ask you to re-enter your **password**
  once to resume syncing — your login stays intact, this just re-derives the local
  encryption key, which is deliberately never written to disk. This never requires the
  recovery passphrase unless the device's local setup gets lost somehow, in which case
  the popup will guide you through reconnecting it (password + passphrase again).
- Forgot your password? Click "Forgot your password?" on the login screen and use your
  recovery passphrase to set a new one.
- Browsing history sync is off by default. Turn it on in the popup's **Settings** tab if
  you want it, and set how many days of history to keep synced.
- Click **"View synced data"** in the popup to open a page showing exactly what's
  currently stored on the server for your account — your bookmark tree, your synced
  history (searchable), and the last-synced list of installed extensions — decrypted
  locally, right there in the page. It's a good way to confirm a sync actually went
  through, or to check what another of your devices has synced without switching to it.
- Click **"Saved passwords"** in the popup to open your password vault: add, edit,
  copy and generate passwords, or import the CSV your browser exports
  (`chrome://password-manager/settings` → Export, or `about:logins` → ⋯ → Export
  in Firefox). Passwords are encrypted with the
  same data key as everything else and synced to your other devices; the server
  can't read them. Delete the exported CSV after importing it — it's plain text.
  Turn on **"Suggest and save passwords on websites"** at the top of that page (it asks
  for permission to access websites) to get a key icon in password fields that lists
  your saved accounts for that site, and a "Save password?" prompt after you log in
  somewhere new. Nothing is filled without your click. By default a password saved on
  `example.com` is also offered on its subdomains (`login.example.com`); you can switch
  to host, "starts with" or exact-URL matching globally or per password.
  Note: logging out removes this device's copy of the vault (it comes back from the
  server on the next login), so the popup warns you if there are unsynced changes.
- **Two-step codes (TOTP):** edit a saved password and paste the 2FA key or
  `otpauth://` link a site gives you. The vault page then shows the current code
  with its countdown, and the key icon offers to fill it into the site's
  verification-code field. Bitwarden CSV exports bring their TOTP keys along. Note
  that whoever opens your vault then has both factors.
- **Export / import:** the password page's **Export CSV** gives you a plain-text file
  for moving your passwords to another manager (delete it after importing). For a
  safe copy, the popup's settings → **"Export / import a backup"** downloads one file
  with your passwords, this device's bookmarks and your settings, encrypted with a
  backup password you choose, and can restore it into this or another account. Both
  exports ask for your BrowserSync password first. The server's dashboard can export
  the same two files from its Export card (e.g. from a computer without the
  extension); restoring is done from the extension only.

### 4. Your data, and how to delete it

Read [`PRIVACY.md`](PRIVACY.md) — it explains, in plain language, exactly what's
stored, what the admin can and can't see, and how to permanently delete your account
and all your synced data whenever you want (your server's account page at `/dashboard/` → "Delete my account",
linked from popup → Settings tab → "More settings" → "Open account page").

### Personal vs. work profile

If you use separate browser profiles for personal and work, install the extension in
each profile independently — each one keeps its own server URL, account, and sync
state, so you can point them at different servers or use different accounts without
them interfering with each other.

---

## License

BrowserSync (the extension and the server) is licensed under the
[GNU Affero General Public License v3.0](LICENSE). If you run a modified version of
the server for other people, you must offer them its source code.
