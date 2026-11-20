#!/bin/sh
# Runs once, when the PostgreSQL data volume is created (docker-entrypoint-initdb.d).
# atimtha_owner: owns the database and schema, runs migrations, BYPASSRLS (platform jobs, SECURITY DEFINER functions).
# atimtha_app:   the API's login — row-level security applies, grants come from db/migrations/0002.
set -eu
: "${ATIMTHA_OWNER_PASSWORD:?set ATIMTHA_OWNER_PASSWORD}"
: "${ATIMTHA_APP_PASSWORD:?set ATIMTHA_APP_PASSWORD}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_pw="$ATIMTHA_OWNER_PASSWORD" -v app_pw="$ATIMTHA_APP_PASSWORD" -v db="$POSTGRES_DB" <<'EOSQL'
CREATE ROLE atimtha_owner LOGIN BYPASSRLS PASSWORD :'owner_pw';
CREATE ROLE atimtha_app LOGIN PASSWORD :'app_pw';
ALTER DATABASE :"db" OWNER TO atimtha_owner;
GRANT CONNECT ON DATABASE :"db" TO atimtha_app;
EOSQL
