# R131 owner upgrade candidate — NOT DEPLOYED

Standalone handler candidates derived from customer template. Do not replace existing handlers. Wire as new read-only tasks after verifying service-role authentication, environment names, and response compatibility. Existing FB simulation, IG patrol, Threads public patrol, and schedules remain unchanged. Historical baseline migration and enforcement pending. No live deployment authorized.

## facebook-preview.ts

```ts
const env = (name: string) => Deno.env.get(name) || "";
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {"content-type":"application/json"}
  });

export default async function handleRequest(req: Request): Promise<Response> {
  if (req.method !== "POST")
    return json({error:"method_not_allowed"},405);

  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""; if (!key || req.headers.get("authorization") !== "Bearer " + key) return json({error:"unauthorized"},401);

  const token = env("FB_PAGE_ACCESS_TOKEN");
  const page = env("FB_PAGE_ID");

  if (!token || !/^\d+$/.test(page))
    return json({error:"missing_configuration"},503);

  const base = "https://graph.facebook.com/v27.0/";
  const deadline = Date.now()+25000;

  async function read(path: string) {
    const remaining = deadline-Date.now();
    if (remaining <= 0) throw new Error("budget");
    const r = await fetch(base+path,{
      method:"GET",
      headers:{Authorization:"Bearer "+token},
      signal:AbortSignal.timeout(Math.min(remaining,8000))
    });
    const d = await r.json();
    return {ok:r.ok,http:r.status,data:d};
  }

  let posts = 0;
  let comments = 0;
  let failures = 0;

  try {
    const p = await read(page+"/posts?fields=id&limit=10");
    if (!p.ok || !Array.isArray(p.data.data))
      return json({
        error:"posts_failed",http:p.http,
        error_code:Number(p.data?.error?.code)||null,
        sends:0
      },502);

    for (const post of p.data.data.slice(0,10)) {
      if (!/^\d+(?:_\d+)?$/.test(String(post.id))) {
        failures++;
        continue;
      }
      posts++;
      try {
        const c = await read(
          encodeURIComponent(post.id)+
          "/comments?fields=id&limit=50"
        );
        if (!c.ok || !Array.isArray(c.data.data)) {
          failures++;
          continue;
        }
        comments += c.data.data.length;
      } catch {
        failures++;
      }
    }

    return json({
      status:failures?"partial":"pass",
      posts_scanned:posts,
      comments_scanned:comments,
      failures,
      bounded_scan:true,
      writes:0,
      sends:0
    });
  } catch {
    return json({error:"scan_failed",sends:0},502);
  }
}
```

## instagram-preview.ts

```ts
const reply=(x:unknown,s=200)=>new Response(JSON.stringify(x),{status:s,headers:{"content-type":"application/json"}});
export default async function handleRequest(
  req: Request
): Promise<Response> {
 if(req.method!=="POST")return reply({error:"method_not_allowed"},405);
 const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""; if (!key || req.headers.get("authorization") !== "Bearer " + key) return reply({error:"unauthorized"},401);
 const service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"",base=Deno.env.get("SUPABASE_URL")||"",id=Deno.env.get("IG_BUSINESS_ACCOUNT_ID")||"";
 if(!service||!base||!/^\d+$/.test(id))return reply({error:"missing_configuration"},503);
 const token=Deno.env.get("INSTAGRAM_ACCESS_TOKEN");if(!token)return reply({status:"missing_token",sends:0,production:"NO_GO"},503);
const startedAt = Date.now();
const scanBudgetMs = 25000;

const fetchApi = async (path: string) => {
  const remainingMs =
    scanBudgetMs - (Date.now() - startedAt);

  if (remainingMs <= 0) {
    throw new Error("scan_timeout");
  }

  const r = await fetch(
    "https://graph.facebook.com/v22.0/" + path,
    {
      headers: {
        Authorization: "Bearer " + token
      },
      signal: AbortSignal.timeout(
        Math.min(10000, remainingMs)
      )
    }
  );

  const d = await r.json().catch(() => ({}));

  return {
    ok: r.ok,
    status: r.status,
    data: d
  };
};
 try{
 const rules=await fetch(base+"/rest/v1/r54_reply_templates?platform=eq.instagram&select=keyword",{headers:{apikey:service,Authorization:"Bearer "+service},signal:AbortSignal.timeout(5000)});
 if(!rules.ok)return reply({error:"rules_unavailable"},502);
 const norm=(s:string)=>s.normalize("NFKC").trim().toLowerCase();
 const ruleData = await rules.json();

if (!Array.isArray(ruleData)) {
  return reply({
    error: "invalid_rules_data",
    sends: 0,
    production: "NO_GO"
  }, 502);
}

const keywords = [
  ...new Set<string>(
    ruleData
      .filter(
        (r) => typeof r?.keyword === "string"
      )
      .map(
        (r) => norm(r.keyword)
      )
      .filter(Boolean)
  )
];

if (keywords.length === 0) {
  return reply({
    status: "no_valid_keywords",
    sends: 0,
    replies_enabled: false,
    production: "NO_GO"
  }, 503);
}
 const media=await fetchApi(id+"/media?fields=id&limit=10");
 if(!media.ok)return reply({status:"media_failed",http:media.status,error_code:media.data?.error?.code||null,sends:0,production:"NO_GO"},502);
let checked = 0;
let matched = 0;
let failures = 0;

const matchedIds: string[] = [];
const seenComments = new Set<string>();
if (!Array.isArray(media.data?.data)) {
  return reply({
    status: "invalid_media_data",
    sends: 0,
    production: "NO_GO"
  }, 502);
}

for (const m of media.data.data) {
 if (
   typeof m?.id !== "string" ||
   !/^\d+$/.test(m.id)
 ) {
   failures++;
   continue;
 }

 const comments = await fetchApi(
   encodeURIComponent(m.id) +
   "/comments?fields=id,text&limit=50"
 );
 if (
  !comments.ok ||
  !Array.isArray(comments.data?.data)
) {
  failures++;
  continue;
}
 for (const c of (comments.data.data || [])) {
  if (
    typeof c?.id !== "string" ||
    !/^\d+$/.test(c.id) ||
    typeof c.text !== "string"
  ) {
    continue;
  }

  if (seenComments.has(c.id)) {
    continue;
  }

  seenComments.add(c.id);
  checked++;

  if (
    keywords.some(
      (k: string) => norm(c.text).includes(k)
    )
  ) {
    matched++;
    matchedIds.push(c.id);
  }
}
 }
 return reply({status:failures?"partial":"pass",media_count:(media.data.data||[]).length,comments_checked:checked,keyword_matches:matched,comment_fetch_failures:failures,matched_comment_ids:matchedIds,sends:0,replies_enabled:false,production:"NO_GO"});
 }catch{return reply({status:"scan_error",sends:0,production:"NO_GO"},502)}
}


```

## token-maintenance.ts

```ts
const env = (name: string) => Deno.env.get(name) || "";
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {"content-type":"application/json"}
  });

export default async function handleRequest(req: Request): Promise<Response> {
  if (req.method !== "POST")
    return json({error:"method_not_allowed"},405);

  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""; if (!key || req.headers.get("authorization") !== "Bearer " + key) return json({error:"unauthorized"},401);

  const now = Math.floor(Date.now()/1000);
  const results = [];

  for (const platform of ["facebook","instagram","threads"]) {
    const token = env(
      platform === "facebook" ? "FB_PAGE_ACCESS_TOKEN" :
      platform === "instagram" ? "INSTAGRAM_ACCESS_TOKEN" :
      "THREADS_ACCESS_TOKEN"
    );
    const expiry = Number(env(
      platform === "facebook" ? "FB_TOKEN_EXPIRES_AT" :
      platform === "instagram" ? "IG_TOKEN_EXPIRES_AT" :
      "THREADS_TOKEN_EXPIRES_AT"
    ) || "0");
    const dataExpiry = platform === "threads" ? 0 :
      Number(env("META_DATA_ACCESS_EXPIRES_AT") || "0");
    const expected = platform === "facebook" ? env("FB_PAGE_ID") :
      platform === "instagram" ? env("IG_BUSINESS_ACCOUNT_ID") :
      env("THREADS_ACCOUNT_ID");

    let status = "error";
    let http = 0;
    let errorCode = null;

    try {
      if (!token || !expected ||
          !Number.isFinite(expiry) ||
          !Number.isFinite(dataExpiry))
        throw new Error("missing_configuration");

      const url = platform === "threads"
        ? "https://graph.threads.net/v1.0/me?fields=id"
        : "https://graph.facebook.com/v27.0/" +
          encodeURIComponent(expected) + "?fields=id";

      const response = await fetch(url, {
        headers:{Authorization:"Bearer "+token},
        signal:AbortSignal.timeout(10000)
      });
      http = response.status;
      const data = await response.json();
      errorCode = Number(data?.error?.code) || null;

      if (!response.ok) {
        status = errorCode === 190 ? "invalid" : "error";
      } else if (String(data.id) !== expected) {
        status = "invalid";
      } else {
        const dates = [expiry,dataExpiry].filter(x=>x>0);
        status = dates.some(x=>x<=now) ? "expired" :
          dates.some(x=>x-now<=604800) ? "expiring" :
          dates.length ? "healthy" : "reachable_expiry_unknown";
      }
    } catch {
      status = "error";
    }

    results.push({platform,status,http,error_code:errorCode});
  }

  return json({
    mode:"health_preview",
    results,
    refreshed:0,
    writes:0,
    sent:0
  });
}
```