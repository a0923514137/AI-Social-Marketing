#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "${CONFIRM_NEW_PROJECT:-}" == "${SUPABASE_PROJECT_REF:?}" ]]
[[ "$SUPABASE_PROJECT_REF" =~ ^[a-z0-9]{20}$ ]]
export PGDATABASE="${CUSTOMER_DB_URL:?}" PGSSLMODE=require PGCONNECT_TIMEOUT=15
# Called only after successful guarded quick-install, in the same job.
[[ "${SOCIAL_SCHEDULER_KEY:-}" =~ ^[A-Za-z0-9_.~-]{32,}$ ]] || { echo "Invalid scheduler key format"; exit 2; }
psql -X -q -v ON_ERROR_STOP=1 <<'SQL'
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;
\getenv ref SUPABASE_PROJECT_REF
\getenv scheduler SOCIAL_SCHEDULER_KEY
select vault.create_secret('https://' || :'ref' || '.supabase.co','customer_social_url') as secret_id \gset
select vault.create_secret(:'scheduler','customer_social_scheduler') as secret_id \gset
select cron.schedule('customer-threads-preview','*/5 * * * *',$job$
select net.http_post(
 url := (select decrypted_secret from vault.decrypted_secrets where name='customer_social_url') || '/functions/v1/social-worker',
 headers := jsonb_build_object('Content-Type','application/json','x-social-scheduler-key',(select decrypted_secret from vault.decrypted_secrets where name='customer_social_scheduler')),
 body := '{"task":"threads_scan","mode":"preview"}'::jsonb
);
$job$);
select cron.schedule('customer-instagram-preview','2-59/5 * * * *',$job$
select net.http_post(
 url := (select decrypted_secret from vault.decrypted_secrets where name='customer_social_url') || '/functions/v1/instagram-patrol',
 headers := jsonb_build_object('Content-Type','application/json','x-social-scheduler-key',(select decrypted_secret from vault.decrypted_secrets where name='customer_social_scheduler')),
 body := '{}'::jsonb
);
$job$);
commit;
SQL
echo "PREVIEW_SCHEDULES_CREATED; SEND=DISABLED"
