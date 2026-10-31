#!/usr/bin/env bash
# Roda uma vez, no primeiro start do volume do Postgres (docker-entrypoint-initdb.d).
# Cria os papéis da D7.3:
#   - wagering_owner: dono do banco; só as migrations o usam;
#   - wagering_app: a aplicação; recebe privilégios só pelos GRANTs das migrations.
# Os nomes são fixos porque as migrations dão GRANT a eles pelo nome.
# O superusuário (POSTGRES_USER) existe só para este init.
# As senhas vêm do ambiente do container: nada de segredo no repositório.

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_password="$DB_OWNER_PASSWORD" \
  -v app_password="$DB_APP_PASSWORD" \
  -v db="$POSTGRES_DB" <<'SQL'
CREATE ROLE wagering_owner LOGIN PASSWORD :'owner_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE wagering_app LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;

ALTER DATABASE :"db" OWNER TO wagering_owner;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"db" TO wagering_owner;
GRANT CONNECT ON DATABASE :"db" TO wagering_app;

-- No PG 15+ o schema public pertence a pg_database_owner (o dono acima)
-- e PUBLIC já não tem CREATE nele. Explícito para não depender da versão.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SQL
