# 2026-11-25 Staging snapshot
- r56-social-content-staging v22; threads-keyword-search-v2-staging v14; verify_jwt=true.
- Existing cron job 16: every 5 minutes, threads_patrol. Public search 海巡, RECENT + TOP, 50 each, 24h window, max 10 notifications/run, Taiwan date + post ID dedup. Existing Telegram destination and own-comment patrol retained. No public auto-comment or AI analysis.
- Diagnostic mode: AI, coffee, 台中, 甜點, 股票, 海巡, 創業. HTTP 200 all; own hits 73 (not unique), other 0. Meta permission shows available for testing. Advanced access review blocked pending technical provider/business verification. Do not change provider identity without approval.
- Secrets are configured externally: THREADS_PATROL_V2_ACCESS_TOKEN, THREADS_PATROL_V2_ADMIN_KEY, existing THREADS_ACCESS_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID. No values included.
- Source snapshot only; not an installable complete deployment package. No deployment or cron changes from this backup. Public search E2E blocked; Production NO_GO.

## Daily dedup migration reference
```sql
create table if not exists public.threads_public_patrol_daily (patrol_date date not null, post_id text not null, state text not null check(state in ('claimed','sent','uncertain')), created_at timestamptz not null default now(), primary key(patrol_date,post_id));
alter table public.threads_public_patrol_daily enable row level security;
revoke all on public.threads_public_patrol_daily from public,anon,authenticated;
grant select,insert,update on public.threads_public_patrol_daily to service_role;
```
