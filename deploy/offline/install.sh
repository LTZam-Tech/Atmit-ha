#!/bin/sh
# Install or upgrade Atimtha from the offline bundle (no internet needed on this host).
#   ./offline/install.sh            loads the images, checks the settings, starts the platform
# Prerequisites: Docker Engine 24+ with the compose plugin; 4 CPU, 8 GB RAM, 50 GB disk for a small installation.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

echo "→ loading images"
docker load -i images.tar.gz

env_file=compose/.env.prod
if [ ! -f "$env_file" ]; then
  cp compose/.env.prod.example "$env_file"
  chmod 600 "$env_file"
  echo "Created $env_file: fill in every value, then run this script again."
  exit 1
fi
# every required value must be filled in
missing=$(grep -E '^(POSTGRES_PASSWORD|ATIMTHA_OWNER_PASSWORD|ATIMTHA_APP_PASSWORD|ATIMTHA_PUBLIC_URL|ATIMTHA_OIDC_ISSUER|ATIMTHA_JOB_SIGNING_KEY|ATIMTHA_EVIDENCE_KEY)=$' "$env_file" | cut -d= -f1 || true)
if [ -n "$missing" ]; then echo "Fill in these settings in $env_file:" >&2; echo "$missing" >&2; exit 1; fi

echo "→ starting (migrations run first)"
docker compose -f compose/docker-compose.prod.yml --env-file "$env_file" up -d --no-build
docker compose -f compose/docker-compose.prod.yml --env-file "$env_file" ps
echo "Atimtha $(cat VERSION) is starting. Backups: ./backup/backup.sh"
