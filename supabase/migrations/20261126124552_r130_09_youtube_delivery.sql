begin;

create table public.r130_youtube_settings (
  channel_id text primary key,
  baseline_at timestamptz not null,
  send_enabled boolean not null default false
);

create table public.r130_youtube_quota (
  quota_day date primary key,
  units integer not null default 0 check (units between 0 and 10000),
  send_attempts integer not null default 0 check (send_attempts between 0 and 150),
  blocked boolean not null default false
);

create table public.r130_youtube_claims (
  channel_id text not null references public.r130_youtube_settings(channel_id),
  comment_id text not null,
  reply_text text not null,
  state text not null check (state in ('sending', 'uncertain', 'sent', 'rejected')),
  response_id text,
  attempted_at timestamptz not null,
  checked_at timestamptz,
  primary key (channel_id, comment_id),
  check ((state = 'sent') = (response_id is not null))
);

create index r130_youtube_recovery_idx on public.r130_youtube_claims
  (channel_id, coalesce(checked_at, attempted_at))
  where state in ('sending', 'uncertain');

alter table public.r130_youtube_settings enable row level security;
alter table public.r130_youtube_quota enable row level security;
alter table public.r130_youtube_claims enable row level security;
revoke all on public.r130_youtube_settings, public.r130_youtube_quota, public.r130_youtube_claims
  from public, anon, authenticated;
grant select, insert, update on public.r130_youtube_settings, public.r130_youtube_quota, public.r130_youtube_claims
  to service_role;

create function public.r130_youtube_setup(p_channel text, p_baseline timestamptz default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare result jsonb;
begin
  if p_baseline > statement_timestamp() or p_baseline = '-infinity'::timestamptz then
    raise exception 'invalid YouTube baseline';
  end if;
  insert into public.r130_youtube_settings(channel_id, baseline_at)
    values (p_channel, coalesce(p_baseline, statement_timestamp())) on conflict do nothing;
  select jsonb_build_object('baseline_at', baseline_at, 'send_enabled', send_enabled) into result
    from public.r130_youtube_settings where channel_id = p_channel;
  return result;
end;
$$;

create function public.r130_youtube_reserve(
  p_channel text,
  p_comment text default null,
  p_author text default null,
  p_published timestamptz default null,
  p_text text default null
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  request_time timestamptz;
  day_key date;
  cost integer := case when p_comment is null then 1 else 50 end;
  quota public.r130_youtube_quota%rowtype;
  settings public.r130_youtube_settings%rowtype;
begin
  if p_comment is not null then
    select * into settings from public.r130_youtube_settings
      where channel_id = p_channel for share;
    if not found or not settings.send_enabled then
      return jsonb_build_object('status', 'disabled');
    end if;
    if p_author is null or p_author = '' or p_author = p_channel or p_published is null
       or p_published <= settings.baseline_at or p_published > clock_timestamp()
       or p_text is null or btrim(p_text) = '' or p_comment = '' then
      return jsonb_build_object('status', 'ineligible');
    end if;
  end if;

  loop
    request_time := clock_timestamp();
    day_key := (request_time at time zone 'America/Los_Angeles')::date;
    insert into public.r130_youtube_quota(quota_day) values (day_key) on conflict do nothing;
    select * into strict quota from public.r130_youtube_quota
      where quota_day = day_key for update;
    request_time := clock_timestamp();
    exit when day_key = (request_time at time zone 'America/Los_Angeles')::date;
  end loop;

  if quota.blocked or quota.units + cost > 10000 then
    return jsonb_build_object('status', 'quota');
  end if;
  if p_comment is not null then
    if ((request_time + interval '20 seconds') at time zone 'America/Los_Angeles')::date <> day_key then
      return jsonb_build_object('status', 'day_rollover');
    end if;
    if quota.send_attempts >= 150 then return jsonb_build_object('status', 'daily_limit'); end if;
    insert into public.r130_youtube_claims(channel_id, comment_id, reply_text, state, attempted_at)
      values (p_channel, p_comment, p_text, 'sending', request_time) on conflict do nothing;
    if not found then return jsonb_build_object('status', 'duplicate'); end if;
  end if;
  update public.r130_youtube_quota
    set units = units + cost,
        send_attempts = send_attempts + case when p_comment is null then 0 else 1 end
    where quota_day = day_key;
  return jsonb_build_object('status', 'reserved', 'quota_day', day_key, 'attempted_at', request_time);
end;
$$;

create function public.r130_youtube_finish(
  p_channel text, p_comment text, p_state text, p_response text default null
)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_state not in ('uncertain', 'sent', 'rejected') or p_state is null then
    raise exception 'invalid YouTube claim state';
  end if;
  update public.r130_youtube_claims
    set state = p_state, response_id = p_response, checked_at = clock_timestamp()
    where channel_id = p_channel and comment_id = p_comment
      and (state = 'sending' or (state = 'uncertain' and p_state in ('uncertain', 'sent')));
  return found;
end;
$$;

create function public.r130_youtube_pending(p_channel text)
returns jsonb language sql security invoker set search_path = '' as $$
  with pending as (
    select channel_id, comment_id from public.r130_youtube_claims
    where channel_id = p_channel and state in ('sending', 'uncertain')
      and coalesce(checked_at, attempted_at) <= statement_timestamp() - interval '2 minutes'
    order by coalesce(checked_at, attempted_at), comment_id
    limit 5 for update skip locked
  ), leased as (
    update public.r130_youtube_claims c set checked_at = statement_timestamp()
    from pending p where (c.channel_id, c.comment_id) = (p.channel_id, p.comment_id)
    returning c.comment_id, c.reply_text, c.attempted_at
  )
  select coalesce(jsonb_agg(to_jsonb(leased)), '[]'::jsonb) from leased;
$$;

create function public.r130_youtube_known(p_channel text, p_comments text[])
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(comment_id), '[]'::jsonb)
  from public.r130_youtube_claims where channel_id = p_channel and comment_id = any(p_comments);
$$;

revoke execute on function public.r130_youtube_setup(text,timestamptz),
  public.r130_youtube_reserve(text,text,text,timestamptz,text),
  public.r130_youtube_finish(text,text,text,text), public.r130_youtube_pending(text),
  public.r130_youtube_known(text,text[]) from public, anon, authenticated;
grant execute on function public.r130_youtube_setup(text,timestamptz),
  public.r130_youtube_reserve(text,text,text,timestamptz,text),
  public.r130_youtube_finish(text,text,text,text), public.r130_youtube_pending(text),
  public.r130_youtube_known(text,text[]) to service_role;

commit;
