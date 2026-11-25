#!/bin/sh
# Создаёт роли «Дриповщицы» при первом старте PostgreSQL на пустом томе.
# drip_girl_owner владеет схемой и применяет миграции, drip_girl_app —
# ограниченная роль приложения без права изменять структуру базы.
set -eu

: "${DRIP_GIRL_OWNER_PASSWORD:?Задайте DRIP_GIRL_OWNER_PASSWORD}"
: "${DRIP_GIRL_APP_PASSWORD:?Задайте DRIP_GIRL_APP_PASSWORD}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_password="$DRIP_GIRL_OWNER_PASSWORD" \
  -v app_password="$DRIP_GIRL_APP_PASSWORD" \
  -v dbname="$POSTGRES_DB" <<'SQL'
CREATE ROLE drip_girl_owner LOGIN PASSWORD :'owner_password';
CREATE ROLE drip_girl_app LOGIN PASSWORD :'app_password';
REVOKE CONNECT, TEMPORARY ON DATABASE :"dbname" FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE :"dbname" TO drip_girl_owner, drip_girl_app;
GRANT USAGE, CREATE ON SCHEMA public TO drip_girl_owner;
GRANT USAGE ON SCHEMA public TO drip_girl_app;
ALTER DEFAULT PRIVILEGES FOR ROLE drip_girl_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO drip_girl_app;
SQL
