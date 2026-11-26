"""Integration tests. Run only against a disposable local PostgreSQL database."""
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent.parent
URL = os.environ["UNIFICATION_TEST_DB"]
if not URL.startswith(("postgresql://postgres:postgres@127.0.0.1:", "postgresql://postgres@127.0.0.1:")):
    raise SystemExit("Use a disposable local PostgreSQL database at 127.0.0.1.")


def sql(statement=None, *, path=None):
    args = ["psql", URL, "-XqtA", "-v", "ON_ERROR_STOP=1"]
    args += ["-f", str(path)] if path else []
    result = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", input=statement)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


sql("""
create role anon;
create role authenticated;
create role service_role bypassrls;
create table public.r53_keyword_rules(
  id bigint primary key, platform text not null, post_id text not null,
  keyword text not null, reply_text text not null, enabled boolean not null);
insert into public.r53_keyword_rules values
  (1,'instagram','42','VIP','Only on this post',true),
  (2,'facebook','12_43','hidden','Disabled',false);
""")
sql(path=ROOT.parent / "supabase/bootstrap/001_social_schema.sql")
sql("""
insert into public.r54_reply_templates(platform,template_key,keyword,reply_text) values
  ('instagram','test','ＡＩ','Common'),('facebook','test','ai','Common'),('threads','test','AI','Common');
""")
sql(path=next((ROOT / "migrations").glob("*_social_unification.sql")))


def event(update, action, value="null", reply="null"):
    return sql(f"""
      set role service_role;
      select public.social_admin_event('admin','chat',{update},'{action}',{value},{reply})->>'kind';
    """)


assert sql("select count(*) from public.social_keywords") == "2"
assert sql("select count(*) from public.social_keyword_posts") == "1"
assert sql("select count(*) from jsonb_array_elements(public.social_rules('threads'))") == "1"
assert sql("select public.social_rules('instagram') @> '[{\"keyword\":\"VIP\",\"global\":false,\"post_ids\":[\"42\"]}]'") == "t"
assert sql("select not has_function_privilege('anon','public.social_admin_event(text,text,bigint,text,text,text)','execute')") == "t"
assert sql("select not has_table_privilege('authenticated','public.social_keywords','select')") == "t"

assert event(1, "begin_add") == "keyword"
assert event(2, "text", "'測試'") == "add_reply"
assert event(3, "text", "'統一回覆'") == "confirm_add"
assert event(4, "confirm", "'00000000-0000-0000-0000-000000000001'") == "stale"
nonce = sql("select nonce from public.social_admin_drafts")
assert event(5, "confirm", f"'{nonce}'") == "added"
assert event(5, "confirm", f"'{nonce}'") == "added"
assert event(6, "add", "'測試'", "'duplicate'") == "exists"
assert event(7, "edit", "'測試'", "'Updated'") == "edited"
for platform in ("instagram", "facebook", "threads"):
    assert sql(f"select public.social_rules('{platform}') @> '[{{\"reply_text\":\"Updated\"}}]'") == "t"

rule = sql("select id from public.social_keywords where keyword='測試'")
assert event(8, "pick_delete", f"'{rule}'") == "confirm_delete"
nonce = sql("select nonce from public.social_admin_drafts")
assert event(9, "edit", "'測試'", "'Concurrent change'") == "edited"
# An independent admin updates after the first admin opened a confirmation.
sql(f"select public.social_admin_event('admin','chat',10,'pick_delete','{rule}')")
nonce = sql("select nonce from public.social_admin_drafts")
sql("select public.social_admin_event('second','chat',11,'edit','測試','Changed again')")
assert event(12, "confirm", f"'{nonce}'") == "stale"
assert event(13, "delete", "'測試'") == "deleted"

assert sql("select not enabled from public.social_reply_switch") == "t"
assert event(14, "on") == "on"
claim = """set role service_role; select public.social_reserve_reply('instagram','17','42',
  now(), (select activated_at from public.social_reply_switch));"""
with ThreadPoolExecutor(max_workers=12) as workers:
    results = list(workers.map(lambda _: sql(claim), range(24)))
assert results.count("t") == 1 and results.count("f") == 23, results
assert sql("select count(*) from public.r54_reply_claims") == "1"
assert sql("""select not public.social_reserve_reply('instagram','old','42',activated_at,activated_at)
              from public.social_reply_switch""") == "t"
assert event(15, "off") == "off"
assert sql(claim.replace("'17'", "'18'")) == "f"

print("PostgreSQL: migration, platform/scope matching, Telegram confirmation/replay, ACLs and 24 parallel claims passed")
