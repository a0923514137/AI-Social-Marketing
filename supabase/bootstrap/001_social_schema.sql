begin;
create schema threads_patrol;
create table public.r54_reply_controls(platform text primary key check(platform in ('facebook','instagram','threads')),send_enabled boolean not null default false,updated_at timestamptz not null default now());
create table public.r54_reply_templates(platform text not null references public.r54_reply_controls(platform),template_key text not null,keyword text not null check(length(trim(keyword))>0),reply_text text not null,created_at timestamptz not null default now(),primary key(platform,template_key));
create table public.r54_reply_claims(platform text not null references public.r54_reply_controls(platform),comment_id text not null,post_id text not null,rule_id bigint,state text not null default 'reserved' check(state in ('reserved','sending','sent','failed','uncertain')),response_id text,error_code text,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),primary key(platform,comment_id));
insert into public.r54_reply_controls(platform) values ('facebook'),('instagram'),('threads');
create table threads_patrol.settings(id boolean primary key default true check(id),baseline_at timestamptz not null default now());
insert into threads_patrol.settings(id) values(true);
create table threads_patrol.reply_outbox(reply_id text primary key,post_id text not null,username text not null,body text,reply_created_at timestamptz,status text not null default 'pending' check(status in ('pending','leased','sent','dead')),attempts integer not null default 0,next_attempt_at timestamptz not null default now(),lease_until timestamptz,lease_id uuid,last_error text,notified_at timestamptz,created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create index on threads_patrol.reply_outbox(status,next_attempt_at);
CREATE OR REPLACE FUNCTION threads_patrol.claim_replies(p_limit integer DEFAULT 10)
 RETURNS TABLE(reply_id text, post_id text, username text, body text, lease_id uuid, attempts integer)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
 if p_limit<1 or p_limit>50 then raise exception 'invalid limit'; end if;
 return query
 with candidates as (
 select o.reply_id from threads_patrol.reply_outbox o
 where (o.status='pending' and o.next_attempt_at<=now())
 or (o.status='leased' and o.lease_until<now())
 order by o.next_attempt_at,o.created_at
 for update skip locked limit p_limit
 )
 update threads_patrol.reply_outbox o set
 status='leased',lease_id=gen_random_uuid(),lease_until=now()+interval '3 minutes',
 attempts=o.attempts+1,updated_at=now()
 from candidates c where o.reply_id=c.reply_id
 returning o.reply_id,o.post_id,o.username,o.body,o.lease_id,o.attempts;
end $function$;

CREATE OR REPLACE FUNCTION threads_patrol.enqueue_reply(p_reply_id text, p_post_id text, p_username text, p_body text DEFAULT NULL::text, p_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
 if nullif(btrim(p_reply_id),'') is null or nullif(btrim(p_post_id),'') is null or nullif(btrim(p_username),'') is null then raise exception 'invalid reply'; end if;
 insert into threads_patrol.reply_outbox(reply_id,post_id,username,body,reply_created_at)
 values(p_reply_id,p_post_id,p_username,p_body,p_created_at)
 on conflict(reply_id) do nothing;
 return found;
end $function$;

CREATE OR REPLACE FUNCTION threads_patrol.finish_reply(p_reply_id text, p_lease_id uuid, p_success boolean, p_error text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
 update threads_patrol.reply_outbox o set
 status=case when p_success then 'sent' when o.attempts>=5 then 'dead' else 'pending' end,
 notified_at=case when p_success then now() else o.notified_at end,
 next_attempt_at=case when p_success then o.next_attempt_at else now()+make_interval(secs=>least(3600,60*power(2,least(o.attempts,5))::int)) end,
 lease_until=null,lease_id=null,last_error=case when p_success then null else left(coalesce(p_error,'notification failed'),500) end,
 updated_at=now()
 where o.reply_id=p_reply_id and o.lease_id=p_lease_id and o.status='leased' and o.lease_until>now();
 return found;
end $function$;

CREATE OR REPLACE FUNCTION public.threads_patrol_baseline()
 RETURNS timestamp with time zone
 LANGUAGE sql
 SET search_path TO ''
AS $function$ select baseline_at from threads_patrol.settings where id=true $function$;

CREATE OR REPLACE FUNCTION public.threads_patrol_claim(p_limit integer DEFAULT 10)
 RETURNS TABLE(reply_id text, post_id text, username text, body text, lease_id uuid, attempts integer)
 LANGUAGE sql
 SET search_path TO ''
AS $function$ select * from threads_patrol.claim_replies(p_limit) $function$;

CREATE OR REPLACE FUNCTION public.threads_patrol_enqueue(p_reply_id text, p_post_id text, p_username text, p_body text DEFAULT NULL::text, p_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS boolean
 LANGUAGE sql
 SET search_path TO ''
AS $function$ select threads_patrol.enqueue_reply(p_reply_id,p_post_id,p_username,p_body,p_created_at) $function$;

CREATE OR REPLACE FUNCTION public.threads_patrol_finish(p_reply_id text, p_lease_id uuid, p_success boolean, p_error text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE sql
 SET search_path TO ''
AS $function$ select threads_patrol.finish_reply(p_reply_id,p_lease_id,p_success,p_error) $function$;
alter table public.r54_reply_controls enable row level security;
revoke all on public.r54_reply_controls from public,anon,authenticated;
grant select,insert,update,delete on public.r54_reply_controls to service_role;
alter table public.r54_reply_templates enable row level security;
revoke all on public.r54_reply_templates from public,anon,authenticated;
grant select,insert,update,delete on public.r54_reply_templates to service_role;
alter table public.r54_reply_claims enable row level security;
revoke all on public.r54_reply_claims from public,anon,authenticated;
grant select,insert,update,delete on public.r54_reply_claims to service_role;
alter table threads_patrol.settings enable row level security;
revoke all on threads_patrol.settings from public,anon,authenticated;
grant select,insert,update,delete on threads_patrol.settings to service_role;
alter table threads_patrol.reply_outbox enable row level security;
revoke all on threads_patrol.reply_outbox from public,anon,authenticated;
grant select,insert,update,delete on threads_patrol.reply_outbox to service_role;
revoke all on schema threads_patrol from public,anon,authenticated;
grant usage on schema threads_patrol to service_role;
revoke execute on all functions in schema threads_patrol from public,anon,authenticated;
grant execute on all functions in schema threads_patrol to service_role;
revoke execute on function public.threads_patrol_baseline() from public,anon,authenticated;
grant execute on function public.threads_patrol_baseline() to service_role;
revoke execute on function public.threads_patrol_enqueue(text,text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.threads_patrol_enqueue(text,text,text,text,timestamptz) to service_role;
revoke execute on function public.threads_patrol_claim(integer) from public,anon,authenticated;
grant execute on function public.threads_patrol_claim(integer) to service_role;
revoke execute on function public.threads_patrol_finish(text,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.threads_patrol_finish(text,uuid,boolean,text) to service_role;
commit;
