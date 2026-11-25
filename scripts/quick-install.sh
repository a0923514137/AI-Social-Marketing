#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${SUPABASE_PROJECT_REF:?Set customer project ref}"
: "${SUPABASE_ACCESS_TOKEN:?Set customer access token securely}"
: "${CUSTOMER_DB_URL:?Set customer PostgreSQL URL securely}"
[[ "$SUPABASE_PROJECT_REF" =~ ^[a-z0-9]{20}$ ]] || exit 2
[[ "${CONFIRM_NEW_PROJECT:-}" == "$SUPABASE_PROJECT_REF" ]] || { echo "Confirm fresh project ref first"; exit 2; }
command -v psql >/dev/null
command -v supabase >/dev/null
supabase functions deploy --help | grep -q -- '--no-verify-jwt'
supabase secrets set --help | grep -q -- '--project-ref'
# Bind database URL to project: direct host or pooler username.
python3 - <<'PY'
import os, urllib.parse
u=urllib.parse.urlparse(os.environ["CUSTOMER_DB_URL"])
r=os.environ["SUPABASE_PROJECT_REF"]
assert u.scheme in ("postgres","postgresql")
assert (u.hostname=="db."+r+".supabase.co" and u.username=="postgres") or (u.hostname and u.hostname.endswith(".pooler.supabase.com") and u.username=="postgres."+r), "Database target mismatch"
PY
# Never print connection string or tokens.
export PGDATABASE="$CUSTOMER_DB_URL"
export PGSSLMODE=require
export PGCONNECT_TIMEOUT=15
existing=$(psql -X -Atq -v ON_ERROR_STOP=1 -c "select count(*) from pg_tables where schemaname in ('public','threads_patrol')")
[[ "$existing" == 0 ]] || { echo "Nonempty database: stop; manual recovery required"; exit 3; }
functions=$(supabase functions list --project-ref "$SUPABASE_PROJECT_REF" -o json)
printf '%s' "$functions" | python3 -c 'import sys,json; assert json.load(sys.stdin)==[], "Existing functions: stop"'
supabase secrets set --project-ref "$SUPABASE_PROJECT_REF" SOCIAL_SEND_ENABLED=false SOCIAL_TELEGRAM_ENABLED=false
psql -X -q -v ON_ERROR_STOP=1 -f supabase/bootstrap/001_social_schema.sql
result=$(psql -X -Atq -v ON_ERROR_STOP=1 -c "select count(*) from public.r54_reply_controls where not send_enabled")
[[ "$result" == 3 ]]
for fn in meta-webhook social-worker instagram-patrol; do
 supabase functions deploy "$fn" --project-ref "$SUPABASE_PROJECT_REF" --no-verify-jwt
done
echo "INSTALL_STAGE=DB_AND_FUNCTIONS_DEPLOYED"
echo "SEND=DISABLED; META_AND_SCHEDULE_ACCEPTANCE=PENDING; NO_GO"
