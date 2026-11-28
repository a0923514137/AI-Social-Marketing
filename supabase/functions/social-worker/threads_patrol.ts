import { normalize } from "../shared/social.ts";

const schedulerRole=(req:Request)=>{const key=Deno.env.get("SOCIAL_SCHEDULER_KEY")||"";return key.length>=32&&req.headers.get("x-social-scheduler-key")===key};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});
const env=(k:string)=>Deno.env.get(k)?.trim()||"";
const graph = new URL("https://graph.threads.net/v1.0/");

async function threadsGet(path: string, token: string) {
  const target = new URL(path, graph);
  if (
    target.origin !== graph.origin || target.username || target.password ||
    !/^\/v1\.0\/(?:me|(?:me|\d+)\/threads|\d+\/replies)$/.test(target.pathname)
  ) throw Error("unexpected_paging_url");
  target.searchParams.delete("access_token");
  const response = await fetch(target, {
    headers: { Authorization: "Bearer " + token },
    redirect: "error",
    signal: AbortSignal.timeout(4500),
  });
  if (!response.ok) throw Error("threads_http_" + response.status);
  return response.json();
}
export default (async(req: Request)=>{
 if(req.method!=="POST")return json({error:"method_not_allowed"},405);
 const schedulerAuth=schedulerRole(req);
 if(!schedulerAuth)return json({error:"unauthorized"},401);
 let input:{mode?:string};try{input=await req.json()}catch{return json({error:"invalid_json"},400)}
 
 if(input.mode==="scan_preview"){
 const token=env("THREADS_ACCESS_TOKEN");
 if(!token)return json({error:"threads_token_missing",writes:0,sent:0},503);
 const service=env("SUPABASE_SERVICE_ROLE_KEY"),url=env("SUPABASE_URL");
 if(!service||!url)return json({error:"db_secrets_missing",writes:0,sent:0},503);
 const rpc=async()=>{const r=await fetch(url+"/rest/v1/rpc/threads_patrol_baseline",{method:"POST",headers:{apikey:service,Authorization:"Bearer "+service,"content-type":"application/json"},body:"{}",redirect:"error",signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error("baseline_http_"+r.status);return r.json()};
 const get=(path:string)=>threadsGet(path,token);
 try{
  const baseline=await rpc();if(!baseline||!Number.isFinite(Date.parse(baseline)))return json({error:"baseline_missing",writes:0,sent:0},403);
  const me=await get("me?fields=id,username");
  const own=typeof me?.username==="string"?normalize(me.username):"";
  if(!own)return json({error:"threads_identity_missing",writes:0,sent:0},502);
  const started=Date.now(),maxMs=18000;let next="me/threads?fields=id,timestamp&limit=10",postsScanned=0,repliesScanned=0,newer=0,postPages=0,replyPages=0,partial=false;
  const seenPosts=new Set<string>(),seenReplies=new Set<string>();
  while(next&&postPages<2&&Date.now()-started<maxMs){
   const page=await get(next);postPages++;
   for(const post of page.data||[]){if(Date.now()-started>=maxMs){partial=true;break;}
    if(!post.id||seenPosts.has(String(post.id)))continue;seenPosts.add(String(post.id));postsScanned++;
    let rn=encodeURIComponent(String(post.id))+"/replies?fields=id,username,timestamp&limit=50",n=0;
    while(rn&&n<2&&Date.now()-started<maxMs){
     const rp=await get(rn);n++;replyPages++;
     for(const item of rp.data||[]){
      if(!item.id||seenReplies.has(String(item.id)))continue;seenReplies.add(String(item.id));
      if(typeof item.username!=="string"||!normalize(item.username)||normalize(item.username)===own)continue;
     repliesScanned++;

const itemCreatedAt =
  typeof item.timestamp === "string"
    ? Date.parse(item.timestamp)
    : NaN;

const baselineAt = Date.parse(baseline);

if (
  Number.isFinite(itemCreatedAt) &&
  Number.isFinite(baselineAt) &&
  baselineAt <= Date.now() &&
  itemCreatedAt > baselineAt &&
  itemCreatedAt <= Date.now()
) {
  newer++;
}
     }
     rn=rp.paging?.next||"";
    }
    if(rn)partial=true;
   }
   next=page.paging?.next||"";
  }
  if(next)partial=true;
  return json({mode:"scan_preview",posts_scanned:postsScanned,replies_scanned:repliesScanned,newer_than_baseline:newer,post_pages:postPages,reply_pages:replyPages,elapsed_ms:Date.now()-started,partial,writes:0,sent:0});
 }catch(e){return json({error:String(e).slice(0,120),writes:0,sent:0},502)}
 }
 if(input.mode!=="run"&&input.mode!=="run_preview")return json({mode:"preview",ready:!!(env("THREADS_ACCESS_TOKEN")&&env("TELEGRAM_BOT_TOKEN")&&env("TELEGRAM_CHAT_ID")&&env("SUPABASE_SERVICE_ROLE_KEY")),sent:0,writes:0});
 const dry=input.mode==="run_preview"||Deno.env.get("SOCIAL_SEND_ENABLED")!=="true"||Deno.env.get("SOCIAL_TELEGRAM_ENABLED")!=="true";
 const token=env("THREADS_ACCESS_TOKEN"),tg=env("TELEGRAM_BOT_TOKEN"),chat=env("TELEGRAM_CHAT_ID"),service=env("SUPABASE_SERVICE_ROLE_KEY"),url=env("SUPABASE_URL");
 if(!token||!service||!url||(!dry&&(!tg||!chat)))return json({error:"missing_secrets",sent:0},503);
 const rpc=async(name:string,payload:unknown)=>{const r=await fetch(url+"/rest/v1/rpc/"+name,{method:"POST",headers:{apikey:service,Authorization:"Bearer "+service,"content-type":"application/json"},body:JSON.stringify(payload),redirect:"error",signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error("rpc_"+name+"_"+r.status);return r.json()};
 const get=(path:string)=>threadsGet(path,token);
 try{
 const baseline=await rpc("threads_patrol_baseline",{});if(!baseline||!Number.isFinite(Date.parse(baseline)))return json({error:"baseline_missing",sent:0},403);
 const me=await get("me?fields=id,username");
 const own=typeof me?.username==="string"?normalize(me.username):"";
 if(!own)return json({error:"threads_identity_missing",writes:0,sent:0},502);
 const started=Date.now(),budget=18000;let next="me/threads?fields=id,timestamp&limit=10",postPages=0,replyPages=0,posts=0,found=0,queued=0,sent=0,failed=0,partial=false;
 const seenPosts=new Set<string>(),seenReplies=new Set<string>();
 while(next&&postPages<2&&Date.now()-started<budget){
 const page=await get(next);postPages++;
 for(const post of page.data||[]){
  if(Date.now()-started>=budget){partial=true;break}
  if(!post.id||seenPosts.has(String(post.id)))continue;seenPosts.add(String(post.id));posts++;
  let rn=encodeURIComponent(String(post.id))+"/replies?fields=id,text,username,timestamp&limit=50",rpCount=0;
  while(rn&&rpCount<2&&Date.now()-started<budget){
   const rp=await get(rn);rpCount++;replyPages++;
   for(const reply of rp.data||[]){
    if(!reply.id||seenReplies.has(String(reply.id)))continue;seenReplies.add(String(reply.id));
    const replyCreatedAt =
  typeof reply.timestamp === "string"
    ? Date.parse(reply.timestamp)
    : NaN;

const baselineAt = Date.parse(baseline);

if (
  !Number.isFinite(replyCreatedAt) ||
  !Number.isFinite(baselineAt) ||
  baselineAt > Date.now() ||
  replyCreatedAt <= baselineAt ||
  replyCreatedAt > Date.now() ||
  typeof reply.username !== "string" ||
  !normalize(reply.username) || normalize(reply.username) === own
) {
  continue;
}
    found++;
    if(!dry&&await rpc("threads_patrol_enqueue",{p_reply_id:String(reply.id),p_post_id:String(post.id),p_username:String(reply.username),p_body:String(reply.text||""),p_created_at:reply.timestamp}))queued++;
   }
   rn=rp.paging?.next||"";
  }
  if(rn)partial=true;
 }
 next=page.paging?.next||"";
 }
 if(next)partial=true;
 if(!dry){
 const claimed=await rpc("threads_patrol_claim",{p_limit:10});
 for(const item of claimed){
 let ok = false;
let err = "delivery_unknown";

try {
  const rr = await fetch(
    "https://api.telegram.org/bot" + tg + "/sendMessage",
    {
      method: "POST",
      headers: {"content-type":"application/json"},
      body: JSON.stringify({
        chat_id: chat,
        text: "Threads 新留言\n@" +
          item.username + "\n" +
          String(item.body || "").slice(0,1200)
      }),
      redirect: "error",
      signal: AbortSignal.timeout(5000)
    }
  );

  const d = await rr.json();

  ok = rr.ok && d.ok === true;

  if (!ok) {
    err = "telegram_" + rr.status;
  }
} catch {
  err = "telegram_delivery_unknown";
}

if (ok) {
  const recorded = await rpc("threads_patrol_finish", {
    p_reply_id: item.reply_id,
    p_lease_id: item.lease_id,
    p_success: true,
    p_error: null
  });

  if (recorded !== true) {
    throw Error("telegram_sent_but_record_failed");
  }

  sent++;
} else {
  const recorded = await rpc("threads_patrol_uncertain", {
    p_reply_id: item.reply_id,
    p_lease_id: item.lease_id,
    p_error: err
  });

  if (recorded !== true) {
    throw Error("uncertain_record_failed");
  }

  failed++;
}
 }
 }
 return json({mode:input.mode,posts_scanned:posts,post_pages:postPages,reply_pages:replyPages,found,queued,sent,failed,partial,writes:dry?0:queued,elapsed_ms:Date.now()-started});
 }catch(e){return json({error:String(e).slice(0,120),sent:"unknown"},502)}
});
