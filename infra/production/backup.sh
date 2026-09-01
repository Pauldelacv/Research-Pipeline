#!/usr/bin/env bash
#
# Nightly Postgres backup for the production stack.
#
# Dumps in Postgres's custom format (compressed, and restorable table-by-table
# with pg_restore), keeps a rolling window, and — importantly — verifies the
# dump is readable before deleting anything. An unverified backup is a belief,
# not a backup.
#
#   ./backup.sh                  # write one dump and prune old ones
#   RETAIN_DAYS=30 ./backup.sh
#
# Install as a cron entry; see docs/deployment.md.
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/docker-compose.prod.yml}"
BACKUP_DIR="${BACKUP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backups}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# Read the database credentials from the same .env the stack uses, so there is
# one place to change a password.
ENV_FILE="$(dirname "$COMPOSE_FILE")/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi
PG_USER="${POSTGRES_USER:-frp}"
PG_DB="${POSTGRES_DB:-frp}"

mkdir -p "$BACKUP_DIR"
OUT="$BACKUP_DIR/${PG_DB}-${STAMP}.dump"

echo "[backup] dumping ${PG_DB} to ${OUT}"
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U "$PG_USER" -d "$PG_DB" --format=custom --compress=9 >"$OUT"

# A zero-byte or truncated dump restores as an empty database, silently. Read
# the archive's table of contents back before trusting it.
if ! docker compose -f "$COMPOSE_FILE" exec -T postgres pg_restore --list /dev/stdin <"$OUT" >/dev/null; then
  echo "[backup] FAILED: ${OUT} is not a readable dump; keeping it for inspection" >&2
  exit 1
fi

SIZE="$(du -h "$OUT" | cut -f1)"
echo "[backup] verified ${OUT} (${SIZE})"

echo "[backup] pruning dumps older than ${RETAIN_DAYS} days"
find "$BACKUP_DIR" -name "${PG_DB}-*.dump" -type f -mtime "+${RETAIN_DAYS}" -print -delete

# Backups that live only on the machine they protect do not survive that
# machine. Set BACKUP_SYNC_CMD to ship them somewhere else, e.g.
#   BACKUP_SYNC_CMD="rclone copy $BACKUP_DIR remote:frp-backups"
if [[ -n "${BACKUP_SYNC_CMD:-}" ]]; then
  echo "[backup] syncing offsite"
  eval "$BACKUP_SYNC_CMD"
fi

echo "[backup] done"
