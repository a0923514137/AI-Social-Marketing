#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$SUPABASE_PROJECT_REF" =~ ^[a-z0-9]{20}$ ]]
[[ "${CONFIRM_NEW_PROJECT:-}" == "$SUPABASE_PROJECT_REF" ]]
[[ "${SOCIAL_SCHEDULER_KEY:-}" =~ ^[A-Za-z0-9_.~-]{32,}$ ]]
export PGDATABASE="${CUSTOMER_DB_URL:?}" PGSSLMODE=require PGCONNECT_TIMEOUT=15
psql -X -q -v ON_ERROR_STOP=1 <<'SQL'
begin;
select pg_advisory_xact_lock(642129);
\getenv ref SUPABASE_PROJECT_REF
\getenv scheduler SOCIAL_SCHEDULER_KEY
select count(*) = 1 as target_ok from social_install.installation where project_ref = :'ref' \gset
\if :target_ok
\else
rollback;
\quit
\endif
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;
select vault.create_secret('https://' || :'ref' || '.supabase.co','customer_social_url')
where not exists (select 1 from vault.secrets where name='customer_social_url') \g /dev/null
select vault.create_secret(:'scheduler','customer_social_scheduler')
where not exists (select 1 from vault.secrets where name='customer_social_scheduler') \g /dev/null
select vault.update_secret(id, :'scheduler') from vault.secrets
where name='customer_social_scheduler' \g /dev/null
select cron.schedule('customer-' || endpoint, run_at, format($job$
select net.http_post(
 url := (select decrypted_secret from vault.decrypted_secrets where name='customer_social_url') || '/functions/v1/' || %L,
 headers := jsonb_build_object('Content-Type','application/json','x-social-scheduler-key',(select decrypted_secret from vault.decrypted_secrets where name='customer_social_scheduler')),
 body := %L::jsonb,
 timeout_milliseconds := 40000
);
$job$, endpoint, request_body))
from (values
 ('facebook-preview','0 1 * * *','{}'),
 ('instagram-preview','1 1 * * *','{}'),
 ('threads-preview','2 1 * * *','{"mode":"scan_preview"}'),
 ('token-maintenance','3 1 * * *','{}')
) as spec(endpoint,run_at,request_body);
commit;
SQL
echo 'PREVIEW_SCHEDULES_CONFIGURED; SEND=DISABLED'
