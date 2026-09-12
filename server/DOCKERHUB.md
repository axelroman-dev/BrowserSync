# BrowserSync Server

Self-hosted, multi-user, end-to-end encrypted sync backend for the
[BrowserSync](https://github.com/axelroman-dev/BrowserSync) browser extension — a
bookmark/history sync system for any Chromium-based browser (built for forks without
Chrome Sync, like Helium, but works anywhere).

The server never sees your data in plaintext. Bookmarks/history are encrypted
client-side before they're ever uploaded; this container only stores and relays
ciphertext. See the [full privacy explanation](https://github.com/axelroman-dev/BrowserSync/blob/main/PRIVACY.md).

## Quick start

This image is one half of a two-container setup (the other is Postgres) — use the
`docker-compose.yml` from the repo rather than running this image standalone:

```bash
git clone https://github.com/axelroman-dev/BrowserSync.git
cd BrowserSync/server
cp .env.example .env
# edit .env: set JWT_SECRET and POSTGRES_PASSWORD

docker compose up -d
curl http://localhost:3000/api/health   # {"status":"ok"}
```

To pull this pre-built image instead of building locally, point the `app` service in
`docker-compose.yml` at it:

```yaml
app:
  image: axelromandev/browsersync-server:latest # pin a version/SHA tag in production
```

Full setup instructions (reverse proxy options, backups, closing registration, etc.)
are in the [admin section of the README](https://github.com/axelroman-dev/BrowserSync#for-the-administrator).

## Required environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `JWT_SECRET` | Signs access tokens — generate a long random value |
| `ALLOW_REGISTRATION` | `true`/`false` — closes public signup without a rebuild |

See [`.env.example`](https://github.com/axelroman-dev/BrowserSync/blob/main/server/.env.example)
for the full list.

## Tags

- `latest` — most recent build from `main`
- `<version>` (e.g. `1.0.0`, `1.0`, `1`) — from a pushed git tag `v1.0.0`
- `sha-<short-sha>` — pinned to an exact commit, for reproducible deployments

Built for `linux/amd64` and `linux/arm64` (Raspberry Pi / ARM NAS friendly).

## Source

This is an unofficial, community-run project — not affiliated with Google, the
Chromium project, or any specific browser vendor. Source, issues, and the matching
browser extension: [github.com/axelroman-dev/BrowserSync](https://github.com/axelroman-dev/BrowserSync).
