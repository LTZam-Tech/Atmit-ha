#!/bin/sh
# Offline installation bundle (ADR-0008, backlog §12): images + compose + install, backup and restore scripts in one
# archive, for hosts without internet access.
#   scripts/offline-bundle.sh [version]        default version: package.json "version"
# Result: dist/atimtha-<version>-offline.tar.gz (and its SHA-256), to copy to the target host and run offline/install.sh.
set -eu
cd "$(dirname "$0")/.."
version=${1:-$(node -p "require('./package.json').version")}
registry=${ATIMTHA_REGISTRY:-atimtha}
out=dist/atimtha-$version
rm -rf "$out" && mkdir -p "$out"

echo "→ building images $registry/{platform,web,agent}:$version"
docker build -f platform/Dockerfile -t "$registry/platform:$version" .
docker build -t "$registry/web:$version" web
docker build -f agent/Dockerfile -t "$registry/agent:$version" .
docker pull postgres:16-alpine
docker pull alpine:3.20

echo "→ saving images"
docker save "$registry/platform:$version" "$registry/web:$version" "$registry/agent:$version" postgres:16-alpine alpine:3.20 | gzip > "$out/images.tar.gz"

echo "→ installation files"
mkdir -p "$out/compose" "$out/postgres" "$out/backup" "$out/offline"
cp deploy/compose/docker-compose.prod.yml deploy/compose/.env.prod.example "$out/compose/"
cp deploy/postgres/init-roles.sh "$out/postgres/"
cp deploy/backup/backup.sh deploy/backup/restore.sh "$out/backup/"
cp deploy/offline/install.sh "$out/offline/"
# Kubernetes installations: the chart, with this version's images (pushed to the client's registry first)
mkdir -p "$out/helm"
cp -r deploy/helm/atimtha "$out/helm/"
sed -i "s/^  tag: .*/  tag: \"$version\"/; s#^  registry: atimtha .*#  registry: $registry#" "$out/helm/atimtha/values.yaml"
chmod +x "$out"/postgres/*.sh "$out"/backup/*.sh "$out"/offline/*.sh
printf '%s\n' "$version" > "$out/VERSION"
# the compose file builds nothing offline: images come from images.tar.gz with this version
sed -i "s/^ATIMTHA_VERSION=.*/ATIMTHA_VERSION=$version/; s/^ATIMTHA_REGISTRY=.*/ATIMTHA_REGISTRY=$registry/" "$out/compose/.env.prod.example"

echo "→ archive"
tar -czf "dist/atimtha-$version-offline.tar.gz" -C dist "atimtha-$version"
( cd dist && sha256sum "atimtha-$version-offline.tar.gz" > "atimtha-$version-offline.tar.gz.sha256" )
rm -rf "$out"
echo "dist/atimtha-$version-offline.tar.gz"
