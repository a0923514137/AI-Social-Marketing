import os, re, sys, subprocess, tempfile
names = ["FB_PAGE_ID","FB_PAGE_ACCESS_TOKEN","FB_APP_SECRET","FB_WEBHOOK_VERIFY_TOKEN","IG_BUSINESS_ACCOUNT_ID","IG_USERNAME","IG_APP_SECRET","INSTAGRAM_ACCESS_TOKEN","THREADS_ACCESS_TOKEN","THREADS_ACCOUNT_ID","SOCIAL_SCHEDULER_KEY"]
missing = [n for n in names if not os.environ.get(n)]
if missing:
    sys.exit("Missing secrets: " + ", ".join(missing))
for n in names:
    v = os.environ[n]
    if not re.fullmatch(r"[A-Za-z0-9_.|+/@:=~-]+", v):
        sys.exit("Unsupported characters in secret: " + n)
for n in ("FB_PAGE_ID", "IG_BUSINESS_ACCOUNT_ID", "THREADS_ACCOUNT_ID"):
    if not os.environ[n].isdigit():
        sys.exit("Invalid numeric ID: " + n)
if len(os.environ["SOCIAL_SCHEDULER_KEY"]) < 32:
    sys.exit("Scheduler key must contain at least 32 characters")
if "--upload" in sys.argv:
    ref = os.environ["SUPABASE_PROJECT_REF"]
    if not re.fullmatch(r"[a-z0-9]{20}", ref) or os.environ.get("CONFIRM_NEW_PROJECT") != ref:
        sys.exit("Project confirmation mismatch")
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "secrets.env")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            for n in names:
                f.write(n + "=" + os.environ[n] + "\n")
            for n in ("FB_TOKEN_EXPIRES_AT", "IG_TOKEN_EXPIRES_AT", "THREADS_TOKEN_EXPIRES_AT", "META_DATA_ACCESS_EXPIRES_AT"):
                if os.environ.get(n):
                    if not os.environ[n].isdigit():
                        sys.exit("Invalid expiration epoch: " + n)
                    f.write(n + "=" + os.environ[n] + "\n")
            f.write("SOCIAL_SEND_ENABLED=false\nSOCIAL_TELEGRAM_ENABLED=false\n")
        result = subprocess.run(["supabase", "secrets", "set", "--project-ref", ref, "--env-file", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if result.returncode:
            sys.exit("Secret upload failed; check CLI permissions")
    print("SECRET_UPLOAD=PASS; SEND=DISABLED")
else:
    print("SECRET_PREFLIGHT=PASS")
