begin;

create function public.social_keyword_key(value text)
returns text language sql immutable strict set search_path = ''
as $$ select lower(btrim(normalize(value, NFKC))) $$;

create table public.social_keywords (
  id uuid primary key default gen_random_uuid(),
  keyword text not null,
  keyword_key text generated always as (public.social_keyword_key(keyword)) stored unique,
  reply_text text not null check (char_length(btrim(reply_text)) between 1 and 500),
  global_enabled boolean not null default false,
  revision uuid not null default gen_random_uuid(),
  check (keyword_key <> '')
);
create table public.social_keyword_posts (
  platform text not null check (platform in ('facebook','instagram','threads')),
  post_id text not null check (post_id <> ''),
  keyword_id uuid not null references public.social_keywords on delete cascade,
  primary key (platform, post_id, keyword_id)
);
create index social_keyword_posts_keyword_idx on public.social_keyword_posts(keyword_id);
create table public.social_reply_switch (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  activated_at timestamptz,
  check (not enabled or activated_at is not null)
);
insert into public.social_reply_switch default values;
create table public.social_admin_drafts (
  actor text not null,
  chat text not null,
  phase text not null,
  keyword text,
  reply_text text,
  keyword_id uuid,
  revision uuid,
  nonce uuid not null default gen_random_uuid(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  primary key (actor, chat)
);
create table public.social_admin_updates (
  actor text not null,
  chat text not null,
  update_id bigint not null,
  result jsonb not null,
  primary key (actor, chat, update_id)
);

-- Abort transaction if legacy texts disagree. Keep a single canonical text for
-- both global and post-scoped keyword bindings.
create temporary table social_keyword_import on commit drop as
select public.social_keyword_key(keyword) as keyword_key, keyword, reply_text,
       null::text as platform, null::text as post_id
from public.r54_reply_templates
where platform in ('facebook','instagram','threads')
union all
select public.social_keyword_key(keyword), keyword, reply_text, platform, post_id
from public.r53_keyword_rules
where enabled and platform in ('facebook','instagram','threads');

do $$
begin
  if exists (select 1 from social_keyword_import group by keyword_key having count(distinct reply_text) > 1) then
    raise exception 'Resolve conflicting legacy keyword replies before applying this migration';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.r54_reply_claims'::regclass and contype = 'p'
      and pg_get_constraintdef(oid) = 'PRIMARY KEY (platform, comment_id)'
  ) then
    raise exception 'r54_reply_claims requires PRIMARY KEY (platform, comment_id)';
  end if;
end;
$$;

insert into public.social_keywords(keyword,reply_text,global_enabled)
select min(keyword),min(reply_text),bool_or(platform is null)
from social_keyword_import
group by keyword_key;

insert into public.social_keyword_posts(platform,post_id,keyword_id)
select distinct i.platform,i.post_id,k.id
from social_keyword_import i
join public.social_keywords k using (keyword_key)
where i.platform is not null;

alter table public.social_keywords enable row level security;
alter table public.social_keyword_posts enable row level security;
alter table public.social_reply_switch enable row level security;
alter table public.social_admin_drafts enable row level security;
alter table public.social_admin_updates enable row level security;
revoke all on public.social_keywords, public.social_keyword_posts, public.social_reply_switch,
  public.social_admin_drafts, public.social_admin_updates from public, anon, authenticated;
grant select,insert,update,delete on public.social_keywords, public.social_keyword_posts,
  public.social_reply_switch,public.social_admin_drafts,public.social_admin_updates to service_role;

create function public.social_rules(p_platform text)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'keyword', k.keyword, 'reply_text', k.reply_text,
    'global', k.global_enabled, 'post_ids', coalesce(p.posts, array[]::text[])
  ) order by k.keyword_key), '[]'::jsonb)
  from public.social_keywords k
  left join (
    select keyword_id,array_agg(post_id order by post_id) as posts
    from public.social_keyword_posts where platform = p_platform group by keyword_id
  ) p on p.keyword_id = k.id
  where p_platform in ('facebook','instagram','threads') and (k.global_enabled or p.posts is not null);
$$;

create function public.social_reserve_reply(
  p_platform text, p_comment text, p_post text, p_created timestamptz, p_activation timestamptz
) returns boolean language plpgsql set search_path = '' as $$
begin
  perform 1 from public.social_reply_switch
    where singleton and enabled and activated_at = p_activation
      and p_created > activated_at and p_created <= clock_timestamp()
    for share;
  if not found then return false; end if;
  insert into public.r54_reply_claims(platform,comment_id,post_id,state)
  values (p_platform,p_comment,p_post,'sending')
  on conflict (platform,comment_id) do nothing;
  return found;
end;
$$;

create function public.social_admin_apply(p_action text, p_keyword text, p_reply text,
  p_id uuid default null, p_revision uuid default null)
returns text language plpgsql set search_path = '' as $$
begin
  if p_action in ('on','off') then
    update public.social_reply_switch
      set enabled = p_action = 'on',
          activated_at = case when p_action = 'on' and not enabled then clock_timestamp() else activated_at end
      where singleton;
    return p_action;
  end if;
  if p_action in ('add','edit') and
      (p_reply is null or char_length(btrim(p_reply)) not between 1 and 500) then return 'invalid'; end if;
  if p_id is null and
      (p_keyword is null or char_length(public.social_keyword_key(p_keyword)) not between 1 and 100) then
    return 'invalid';
  end if;
  if p_action = 'add' then
    insert into public.social_keywords(keyword,reply_text,global_enabled)
    values (btrim(p_keyword),p_reply,true)
    on conflict (keyword_key) do nothing;
    if found then return 'added'; else return 'exists'; end if;
  elsif p_action = 'edit' then
    update public.social_keywords
    set reply_text = p_reply, revision = gen_random_uuid()
    where (p_id is null and keyword_key = public.social_keyword_key(p_keyword))
       or (id = p_id and revision = p_revision);
    if found then return 'edited'; end if;
  elsif p_action = 'delete' then
    delete from public.social_keywords
    where (p_id is null and keyword_key = public.social_keyword_key(p_keyword))
       or (id = p_id and revision = p_revision);
    if found then return 'deleted'; end if;
  end if;
  return 'stale';
end;
$$;

create function public.social_admin_event(p_actor text, p_chat text, p_update bigint,
  p_action text, p_value text default null, p_reply text default null)
returns jsonb language plpgsql set search_path = '' as $$
declare
  response jsonb;
  draft public.social_admin_drafts%rowtype;
  rule public.social_keywords%rowtype;
  action_result text;
  page_start integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('social-admin:' || p_actor || ':' || p_chat, 0));
  select result into response from public.social_admin_updates
  where actor = p_actor and chat = p_chat and update_id = p_update;
  if found then return response; end if;

  select * into draft from public.social_admin_drafts
  where actor = p_actor and chat = p_chat and expires_at > now();

  if p_action in ('menu','cancel') then
    delete from public.social_admin_drafts where actor = p_actor and chat = p_chat;
    response := jsonb_build_object('kind','menu');
  elsif p_action in ('on','off','add','edit','delete') then
    response := jsonb_build_object('kind',public.social_admin_apply(p_action,p_value,p_reply));
    delete from public.social_admin_drafts where actor = p_actor and chat = p_chat;
  elsif p_action in ('list','choose_edit','choose_delete') then
    page_start := case when p_value ~ '^[0-9]{1,5}$' then p_value::integer else 0 end;
    select jsonb_build_object('kind',p_action,'offset',page_start,
      'items',coalesce(jsonb_agg(to_jsonb(r) order by r.keyword_key),'[]'::jsonb)) into response
    from (select id,keyword,keyword_key,left(reply_text,160) as reply_text,global_enabled
      from public.social_keywords order by keyword_key limit 9 offset page_start) r;
  elsif p_action = 'begin_add' then
    insert into public.social_admin_drafts(actor,chat,phase) values (p_actor,p_chat,'keyword')
    on conflict (actor,chat) do update set phase = 'keyword', keyword = null, reply_text = null,
      keyword_id = null, revision = null, nonce = default, expires_at = default;
    response := jsonb_build_object('kind','keyword');
  elsif p_action in ('pick_edit','pick_delete') then
    select * into rule from public.social_keywords where id = p_value::uuid;
    if found then
      insert into public.social_admin_drafts(actor,chat,phase,keyword,keyword_id,revision,reply_text)
      values (p_actor,p_chat,case when p_action = 'pick_edit' then 'edit_reply' else 'confirm_delete' end,
        rule.keyword,rule.id,rule.revision,null)
      on conflict (actor,chat) do update set phase = excluded.phase, keyword = excluded.keyword,
        keyword_id = excluded.keyword_id, revision = excluded.revision, reply_text = null,
        nonce = default, expires_at = default
      returning * into draft;
      response := jsonb_build_object('kind',draft.phase,'keyword',draft.keyword,'nonce',draft.nonce);
    end if;
  elsif p_action = 'text' and draft.phase = 'keyword' then
    if char_length(public.social_keyword_key(p_value)) between 1 and 100 then
      update public.social_admin_drafts set keyword = btrim(p_value),phase = 'add_reply',expires_at = default
      where actor = p_actor and chat = p_chat;
      response := jsonb_build_object('kind','add_reply','keyword',btrim(p_value));
    else response := jsonb_build_object('kind','bad_keyword'); end if;
  elsif p_action = 'text' and draft.phase in ('edit_reply','add_reply') then
    if char_length(btrim(p_value)) between 1 and 500 then
      update public.social_admin_drafts set reply_text = p_value,
        phase = case when draft.phase = 'edit_reply' then 'confirm_edit' else 'confirm_add' end,
        expires_at = default where actor = p_actor and chat = p_chat returning * into draft;
      response := jsonb_build_object('kind',draft.phase,'keyword',draft.keyword,'reply',draft.reply_text,'nonce',draft.nonce);
    else response := jsonb_build_object('kind','bad_reply'); end if;
  elsif p_action = 'confirm' and draft.nonce::text = p_value and
      draft.phase in ('confirm_add','confirm_edit','confirm_delete') then
    action_result := public.social_admin_apply(substr(draft.phase,9),draft.keyword,draft.reply_text,
      draft.keyword_id,draft.revision);
    delete from public.social_admin_drafts where actor = p_actor and chat = p_chat;
    response := jsonb_build_object('kind',action_result);
  elsif p_action = 'text' then
    response := jsonb_build_object('kind',case when draft.phase like 'confirm_%' then 'await_confirm' else 'other' end);
  end if;

  response := coalesce(response,jsonb_build_object('kind','stale'));
  insert into public.social_admin_updates values (p_actor,p_chat,p_update,response);
  return response;
end;
$$;

revoke execute on function public.social_keyword_key(text), public.social_rules(text),
  public.social_reserve_reply(text,text,text,timestamptz,timestamptz),
  public.social_admin_apply(text,text,text,uuid,uuid), public.social_admin_event(text,text,bigint,text,text,text)
  from public, anon, authenticated;
grant execute on function public.social_keyword_key(text), public.social_rules(text),
  public.social_reserve_reply(text,text,text,timestamptz,timestamptz),
  public.social_admin_apply(text,text,text,uuid,uuid), public.social_admin_event(text,text,bigint,text,text,text)
  to service_role;

commit;
