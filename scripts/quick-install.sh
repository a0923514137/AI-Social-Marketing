#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${SUPABASE_PROJECT_REF:?Set customer project ref}"
: "${SUPABASE_ACCESS_TOKEN:?Set customer access token securely}"
: "${CUSTOMER_DB_URL:?Set customer PostgreSQL URL securely}"
[[ "$SUPABASE_PROJECT_REF" =~ ^[a-z0-9]{20}$ ]]
[[ "${CONFIRM_NEW_PROJECT:-}" == "$SUPABASE_PROJECT_REF" ]]
command -v psql >/dev/null
command -v supabase >/dev/null
python3 scripts/check-secrets.py
python3 - <<'PY'
import os, urllib.parse
u = urllib.parse.urlparse(os.environ["CUSTOMER_DB_URL"])
r = os.environ["SUPABASE_PROJECT_REF"]
if not (u.scheme in ("postgres", "postgresql") and (
    (u.hostname == "db." + r + ".supabase.co" and u.username == "postgres")
    or (u.hostname and u.hostname.endswith(".pooler.supabase.com") and u.username == "postgres." + r)
)):
    raise SystemExit("Database target mismatch")
PY
export PGDATABASE="$CUSTOMER_DB_URL" PGSSLMODE=require PGCONNECT_TIMEOUT=15
sql() { psql -X -Atq -v ON_ERROR_STOP=1 -c "$1"; }
marker=$(sql "select to_regclass('social_install.installation') is not null")
if [[ "$marker" == t ]]; then
  [[ "$(sql 'select project_ref from social_install.installation')" == "$SUPABASE_PROJECT_REF" ]] || exit 3
  echo 'DATABASE=RESUMED'
else
  [[ "$(sql "select count(*) from pg_tables where schemaname in ('public','threads_patrol','social_install')")" == 0 ]] || { echo 'Unrecognized database; stopped'; exit 3; }
  supabase functions list --project-ref "$SUPABASE_PROJECT_REF" -o json |
    python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin)==[] else "Unrecognized functions; stopped")'
  {
    echo "select pg_advisory_xact_lock(642129);"
    echo "do \$\$ begin if exists (select 1 from pg_tables where schemaname in ('public','threads_patrol','social_install')) then raise exception 'database is not empty'; end if; end \$\$;"
    for migration in supabase/bootstrap/001_social_schema.sql supabase/migrations/*.sql; do
      sed -E '/^[[:space:]]*(begin|commit);[[:space:]]*$/Id' "$migration"
    done
    cat supabase/bootstrap/install-marker.sql
  } | psql -X -q --single-transaction -v ON_ERROR_STOP=1 -v project_ref="$SUPABASE_PROJECT_REF" -f -
  echo 'DATABASE=INITIALIZED'
fi
[[ "$(sql 'select count(*) from public.r54_reply_controls where not send_enabled')" == 3 ]]
python3 scripts/check-secrets.py --upload
# Bulk deploy through the project's per-function verification configuration.
supabase functions deploy --project-ref "$SUPABASE_PROJECT_REF"
echo 'INSTALL_STAGE=DB_AND_FUNCTIONS_DEPLOYED; SEND=DISABLED; PRODUCTION=NO_GO'
