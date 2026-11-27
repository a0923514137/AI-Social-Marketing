import { matchRule, socialDatabase } from "../shared/social.ts";

export default async function facebookPreview(req: Request) {
  const base = Deno.env.get("SUPABASE_URL");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const page = Deno.env.get("FB_PAGE_ID");
  if (!base || !service || !page) {
    return Response.json({ error: "missing_configuration" }, { status: 503 });
  }
  const { mode, events } = await req.json();
  const rules = await socialDatabase(base, service).rules("facebook");
  if (mode === "preview") {
    const token = Deno.env.get("FB_PAGE_ACCESS_TOKEN");
    if (!token || !/^\d+$/.test(page)) return Response.json({error:"missing_configuration",sends:0},{status:503});
    const deadline=Date.now()+25000;
    async function read(path:string) {
      const remaining=deadline-Date.now();
      if(remaining<=0) throw Error("deadline");
      const r=await fetch("https://graph.facebook.com/v22.0/"+path,{headers:{Authorization:"Bearer "+token},redirect:"error",signal:AbortSignal.timeout(Math.min(8000,remaining))});
      const d=await r.json().catch(()=>null);
      return {r,d};
    }
    try {
      const posts=await read(page+"/posts?fields=id&limit=10");
      if(!posts.r.ok||!Array.isArray(posts.d?.data)) return Response.json({error:"facebook_posts_unavailable",http_status:posts.r.status,meta_code:posts.d?.error?.code??null,sends:0},{status:502});
      let checked=0,matched=0,failures=0;
      for(const p of posts.d.data.slice(0,10)){
        const post=String(p?.id||"");
        if(!post.startsWith(page+"_")||!/^\d+_\d+$/.test(post))continue;
        try{
          const c=await read(post+"/comments?fields=id,message,from,created_time&filter=toplevel&limit=50");
          if(!c.r.ok||!Array.isArray(c.d?.data)){failures++;continue;}
          for(const item of c.d.data.slice(0,50)){
            checked++;
            if(!item?.from?.id||String(item.from.id)===page)continue;
            if(matchRule(rules,post,String(item.message||"")))matched++;
          }
          if(c.d.paging?.next)failures++;
        }catch{failures++;}
      }
      return Response.json({status:failures||posts.d.paging?.next?"partial":"pass",posts_checked:posts.d.data.length,checked,matched,failures,sends:0,preview_only:true,production:"NO_GO"});
    }catch{return Response.json({error:"facebook_scan_failed",sends:0},{status:502});}
  }
  const seen = new Set<string>();
  const matches = [];
  const input = Array.isArray(events) ? events.slice(0, 100) : [];
  for (const event of input) {
    const id = String(event?.comment_id || "");
    const author = String(event?.author_id || "");
    if (
      !id || !author || author === page || String(event?.page) !== page ||
      seen.has(id)
    ) continue;
    seen.add(id);
    const rule = matchRule(
      rules,
      String(event.post_id || ""),
      String(event.message || ""),
    );
    if (rule) matches.push({ comment_id: id, proposed_reply: rule.reply_text });
  }
  return Response.json({
    status: "simulated",
    scanned: input.length,
    matched: matches.length,
    matches,
    sent: 0,
    writes: 0,
  });
}
