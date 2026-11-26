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