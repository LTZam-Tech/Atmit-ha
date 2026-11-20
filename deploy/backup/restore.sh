#!/bin/sh
# Restore an Atimtha backup made by backup.sh. Replaces the database and the evidence files.
#   deploy/backup/restore.sh <backup folder>
# The installation must use the same ATIMTHA_EVIDENCE_KEY as when the backup was made.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
compose="docker compose -f $here/../compose/docker-compose.prod.yml --env-file ${ATIMTHA_ENV_FILE:-$here/../compose/.env.prod}"
source=${1:?usage: restore.sh <backup folder>}
[ -f "$source/atimtha.pgdump" ] && [ -f "$source/evidence.tar.gz" ] || { echo "not a backup folder: $source" >&2; exit 2; }
( cd "$source" && sha256sum -c SHA256SUMS ) || { echo "checksums do not match: refusing to restore" >&2; exit 2; }

printf 'This replaces ALL data of this installation with the backup in %s. Type "restore" to continue: ' "$source"
read -r answer
[ "$answer" = "restore" ] || { echo "cancelled"; exit 1; }

echo "→ stopping the platform"
$compose stop api web
echo "→ database"
$compose exec -T postgres pg_restore -U postgres -d atimtha --clean --if-exists --no-owner --role=atimtha_owner < "$source/atimtha.pgdump"
echo "→ evidence files"
docker run --rm -v "${ATIMTHA_EVIDENCE_VOLUME:-atimtha_evidence}:/data" -v "$(cd "$source" && pwd):/backup:ro" alpine:3.20 \
  sh -c 'rm -rf /data/* && tar -xzf /backup/evidence.tar.gz -C /data && chown -R 1654:1654 /data'
echo "→ migrations (a backup from an older version is brought up to date) and start"
$compose up -d
echo "restored from $source"
