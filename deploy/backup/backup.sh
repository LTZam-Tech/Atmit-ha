#!/bin/sh
# Backup of an Atimtha installation (backlog §12): the database (pg_dump, custom format) and the evidence volume
# (encrypted files: keep ATIMTHA_EVIDENCE_KEY with the backup's restore instructions, never inside it).
#   deploy/backup/backup.sh [target folder]          default: ./atimtha-backup-<date>
# Run on the Docker host, from the installation folder; works while the platform is running.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
compose="docker compose -f $here/../compose/docker-compose.prod.yml --env-file ${ATIMTHA_ENV_FILE:-$here/../compose/.env.prod}"
target=${1:-./atimtha-backup-$(date -u +%Y%m%d-%H%M%S)}
mkdir -p "$target"

echo "→ database"
$compose exec -T postgres pg_dump -U postgres -d atimtha --format=custom --no-owner > "$target/atimtha.pgdump"

echo "→ evidence files"
# the compose project is named "atimtha": its evidence volume is atimtha_evidence
docker run --rm -v "${ATIMTHA_EVIDENCE_VOLUME:-atimtha_evidence}:/data:ro" -v "$(cd "$target" && pwd):/backup" alpine:3.20 \
  tar -czf /backup/evidence.tar.gz -C /data .

( cd "$target" && sha256sum atimtha.pgdump evidence.tar.gz > SHA256SUMS )
echo "backup written to $target"
ls -l "$target"
