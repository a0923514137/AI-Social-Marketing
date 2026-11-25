import os, subprocess, json, re, urllib.request, urllib.error
ref=os.environ["SUPABASE_PROJECT_REF"]
assert re.fullmatch("[a-z0-9]{20}",ref) and os.environ["CONFIRM_NEW_PROJECT"]==ref
env=dict(os.environ,PGDATABASE=os.environ["CUSTOMER_DB_URL"],PGSSLMODE="require",PGCONNECT_TIMEOUT="15")
def sql(q):
    return subprocess.check_output(["psql","-X","-Atq","-v","ON_ERROR_STOP=1","-c",q],env=env,text=True).strip()
checks=[]
def check(name,ok):
    checks.append((name,bool(ok)))
    print(name+"="+("PASS" if ok else "FAIL"))
check("DB_CONTROLS",sql("select count(*) from public.r54_reply_controls where not send_enabled")=="3")
check("DB_RLS",sql("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relrowsecurity and ((n.nspname='public' and c.relname in ('r54_reply_controls','r54_reply_templates','r54_reply_claims')) or (n.nspname='threads_patrol' and c.relname in ('settings','reply_outbox')))")=="5")
check("PREVIEW_CRON",sql("select count(*) from cron.job where active and jobname in ('customer-threads-preview','customer-instagram-preview')")=="2")
base="https://"+ref+".supabase.co/functions/v1/"
def request(fn,body,headers):
    req=urllib.request.Request(base+fn,data=json.dumps(body).encode(),headers={"Content-Type":"application/json",**headers})
    try:
        with urllib.request.urlopen(req,timeout=30) as res:
            return res.status,json.loads(res.read())
    except urllib.error.HTTPError as e:
        return e.code,{}
    except Exception:
        return 0,{}
for fn in ("social-worker","instagram-patrol"):
    status,_=request(fn,{}, {})
    check(fn+"_AUTH",status==401)
status,_=request("meta-webhook",{}, {})
check("META_SIGNATURE_REJECT",status==403)
headers={"x-social-scheduler-key":os.environ["SOCIAL_SCHEDULER_KEY"]}
status,data=request("social-worker",{"task":"threads_scan","mode":"preview"},headers)
check("THREADS_CONFIG_PREVIEW",status==200 and data.get("external_sends")==0 and data.get("db_send_enabled") is False)
status,data=request("instagram-patrol",{},headers)
check("IG_READ_ONLY_PREVIEW",status==200 and data.get("status")=="pass" and data.get("sends")==0)
print("META_WEBHOOK_SUBSCRIPTION=PENDING; LIVE_REPLY_TEST=PENDING; PRODUCTION=NO_GO")
if not all(ok for _,ok in checks):
    raise SystemExit(1)
print("INSTALL_BASIC_ACCEPTANCE=PASS")
