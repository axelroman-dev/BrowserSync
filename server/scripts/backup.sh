#!/usr/bin/env bash
# Dumps the BrowserSync Postgres database and rotates old dumps.
#
# Intended to run from the HOST via cron, next to docker-compose.yml, e.g.:
#   0 3 * * * cd /path/to/BrowserSync/server && ./scripts/backup.sh >> /var/log/browsersync-backup.log 2>&1
#
# Dumps only contain encrypted blobs, hashed passwords and hashed refresh
# tokens (see PRIVACY.md) - there is no plaintext bookmark/history content in
# a backup even if the backup file itself were exposed. Still, back the
# backup directory up somewhere access-controlled: it does contain email
# addresses and password/token hashes.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

BACKUP_DIR="${BROWSERSYNC_BACKUP_DIR:-./backups}"
RETENTION_DAYS="${BROWSERSYNC_BACKUP_RETENTION_DAYS:-14}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
OUT_FILE="${BACKUP_DIR}/browsersync_${TIMESTAMP}.sql.gz"

mkdir -p "${BACKUP_DIR}"

echo "Dumping database to ${OUT_FILE}..."
docker compose exec -T db pg_dump -U browsersync browsersync | gzip > "${OUT_FILE}"

echo "Removing dumps older than ${RETENTION_DAYS} days..."
find "${BACKUP_DIR}" -name 'browsersync_*.sql.gz' -mtime "+${RETENTION_DAYS}" -delete

echo "Backup complete: ${OUT_FILE}"
