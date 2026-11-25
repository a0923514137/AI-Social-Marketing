const schedulerRole=(req:Request)=>{try{const t=(req.headers.get("authorization")||"").replace(/^Bearer /,"");const payload=JSON.parse(atob(t.split(".")[1].replace(/-/g,"+").replace(/_/g,"/")));return payload.role==="service_role"&&t.split(".").length===3}catch{return false}};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});
const env=(k:string)=>Deno.env.get(k)?.trim()||"";
export default (async(req)=>{
 if(req.method!=="POST")return json({error:"method_not_allowed"},405);
 const key=env("THREADS_PATROL_ADMIN_KEY");
 const schedulerAuth=schedulerRole(req);
 if((!key||req.headers.get("x-patrol-admin-key")!==key)&&!schedulerAuth)return json({error:"unauthorized"},401);
 let input:{mode?:string};try{input=await req.json()}catch{return json({error:"invalid_json"},400)}
 
 if(input.mode==="test_telegram"){
 const tg=env("TELEGRAM_BOT_TOKEN"),chat=env("TELEGRAM_CHAT_ID");
 if(!tg||!chat)return json({error:"telegram_secrets_missing"},503);
 try{const r=await fetch("https://api.telegram.org/bot"+tg+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chat,text:"Threads 海巡 R32 測試通知（Staging）"})});const d=await r.json();return json({telegram_accepted:r.ok&&d.ok===true,http_status:r.status},r.ok&&d.ok?200:502)}catch{return json({error:"telegram_network"},502)}
 }
 if(input.mode==="scan_preview"){
 const token=env("THREADS_ACCESS_TOKEN");
 if(!token)return json({error:"threads_token_missing",writes:0,sent:0},503);
 const service=env("SUPABASE_SERVICE_ROLE_KEY"),url=env("SUPABASE_URL");
 if(!service||!url)return json({error:"db_secrets_missing",writes:0,sent:0},503);
 const rpc=async()=>{const r=await fetch(url+"/rest/v1/rpc/threads_patrol_baseline",{method:"POST",headers:{apikey:service,Authorization:"Bearer "+service,"content-type":"application/json"},body:"{}"});if(!r.ok)throw Error("baseline_http_"+r.status);return r.json()};
 const get=async(path:string)=>{const target=path.startsWith("https://graph.threads.net/v1.0/")?path:"https://graph.threads.net/v1.0/"+path;if(!target.startsWith("https://graph.threads.net/v1.0/"))throw Error("unexpected_paging_url");const r=await fetch(target,{headers:{Authorization:"Bearer "+token},signal:AbortSignal.timeout(4500)});if(!r.ok)throw Error("threads_http_"+r.status);return r.json()};
 try{
  const baseline=await rpc();if(!baseline||!Number.isFinite(Date.parse(baseline)))return json({error:"baseline_missing",writes:0,sent:0},403);
  const me=await get("me?fields=id,username");
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
      if(!item.username||String(item.username).toLowerCase()===String(me.username||"").toLowerCase())continue;
      repliesScanned++;if(item.timestamp&&Date.parse(item.timestamp)>Date.parse(baseline))newer++;
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
 if(input.mode==="r48_send_once"){
 const token=env("THREADS_ACCESS_TOKEN"),tg=env("TELEGRAM_BOT_TOKEN"),chat=env("TELEGRAM_CHAT_ID"),service=env("SUPABASE_SERVICE_ROLE_KEY"),url=env("SUPABASE_URL");
 if(!token||!tg||!chat||!service||!url)return json({error:"missing_secrets",sent:0},503);
 const rpc=async(name:string,payload:unknown)=>{const r=await fetch(url+"/rest/v1/rpc/"+name,{method:"POST",headers:{apikey:service,Authorization:"Bearer "+service,"content-type":"application/json"},body:JSON.stringify(payload),signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error("rpc_"+name+"_"+r.status);return r.json()};
 const get=async(path:string)=>{const target=path.startsWith("https://graph.threads.net/v1.0/")?path:"https://graph.threads.net/v1.0/"+path;if(!target.startsWith("https://graph.threads.net/v1.0/"))throw Error("paging_url_invalid");const r=await fetch(target,{headers:{Authorization:"Bearer "+token},signal:AbortSignal.timeout(4500)});if(!r.ok)throw Error("threads_"+r.status);return r.json()};
 try{
 const baseline=await rpc("threads_patrol_baseline",{});if(!baseline||!Number.isFinite(Date.parse(baseline)))return json({error:"baseline_missing",sent:0},403);
 const me=await get("me?fields=username");const started=Date.now();let next="me/threads?fields=id&limit=10",found=null,postPages=0,partial=false;
 while(next&&postPages<2&&Date.now()-started<18000&&!found){
 const pg=await get(next);postPages++;
 for(const post of pg.data||[]){
 if(Date.now()-started>=18000)break;
 let rn=encodeURIComponent(String(post.id))+"/replies?fields=id,text,username,timestamp&limit=50",n=0;
 while(rn&&n<2&&Date.now()-started<18000&&!found){
 const rp=await get(rn);n++;
 for(const item of rp.data||[]){
 if(String(item.text||"").trim()!=="海巡 R47 測試 123"||!item.id||!item.timestamp||Date.parse(item.timestamp)<=Date.parse(baseline)||String(item.username||"").toLowerCase()===String(me.username||"").toLowerCase())continue;
 found={id:String(item.id),post_id:String(post.id),username:String(item.username),body:String(item.text),timestamp:String(item.timestamp)};break;
 }
 rn=rp.paging?.next||"";
 }
 if(rn)partial=true;
 if(found)break;
 }
 next=pg.paging?.next||"";
 }
 if(next)partial=true;
 if(!found)return json({mode:"r48_send_once",found:0,sent:0,partial,writes:0});
 const inserted=await rpc("threads_patrol_enqueue",{p_reply_id:found.id,p_post_id:found.post_id,p_username:found.username,p_body:found.body,p_created_at:found.timestamp});
 if(!inserted)return json({mode:"r48_send_once",found:1,duplicate:true,sent:0,writes:0});
 const claimed=await rpc("threads_patrol_claim",{p_limit:1});
 if(claimed.length!==1||String(claimed[0].reply_id)!==found.id)return json({error:"claim_mismatch",found:1,queued:1,sent:0},409);
 const item=claimed[0];let ok=false,err="";
 try{const rr=await fetch("https://api.telegram.org/bot"+tg+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chat,text:"Threads R48 真實留言測試\\n@"+found.username+"\\n"+found.body}),signal:AbortSignal.timeout(5000)});const d=await rr.json();ok=rr.ok&&d.ok===true;if(!ok)err="telegram_"+rr.status}catch{err="telegram_network"}
 await rpc("threads_patrol_finish",{p_reply_id:item.reply_id,p_lease_id:item.lease_id,p_success:ok,p_error:ok?null:err});
 return json({mode:"r48_send_once",found:1,queued:1,sent:ok?1:0,failed:ok?0:1,partial});
 }catch(e){return json({error:String(e).slice(0,120),sent:0},502)}
 }
 
 if(input.mode!=="run"&&input.mode!=="run_preview")return json({mode:"preview",ready:!!(env("THREADS_ACCESS_TOKEN")&&env("TELEGRAM_BOT_TOKEN")&&env("TELEGRAM_CHAT_ID")&&env("SUPABASE_SERVICE_ROLE_KEY")),sent:0,writes:0});
 const dry=input.mode==="run_preview";
 const token=env("THREADS_ACCESS_TOKEN"),tg=env("TELEGRAM_BOT_TOKEN"),chat=env("TELEGRAM_CHAT_ID"),service=env("SUPABASE_SERVICE_ROLE_KEY"),url=env("SUPABASE_URL");
 if(!token||!service||!url||(!dry&&(!tg||!chat)))return json({error:"missing_secrets",sent:0},503);
 const rpc=async(name:string,payload:unknown)=>{const r=await fetch(url+"/rest/v1/rpc/"+name,{method:"POST",headers:{apikey:service,Authorization:"Bearer "+service,"content-type":"application/json"},body:JSON.stringify(payload),signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error("rpc_"+name+"_"+r.status);return r.json()};
 const get=async(path:string)=>{const target=path.startsWith("https://graph.threads.net/v1.0/")?path:"https://graph.threads.net/v1.0/"+path;if(!target.startsWith("https://graph.threads.net/v1.0/"))throw Error("unexpected_paging_url");const r=await fetch(target,{headers:{Authorization:"Bearer "+token},signal:AbortSignal.timeout(4500)});if(!r.ok)throw Error("threads_"+r.status);return r.json()};
 try{
 const baseline=await rpc("threads_patrol_baseline",{});if(!baseline||!Number.isFinite(Date.parse(baseline)))return json({error:"baseline_missing",sent:0},403);
 const me=await get("me?fields=id,username");
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
    if(!reply.timestamp||Date.parse(reply.timestamp)<=Date.parse(baseline)||!reply.username||String(reply.username).toLowerCase()===String(me.username||"").toLowerCase())continue;
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
 let ok=false,err="";
 try{const rr=await fetch("https://api.telegram.org/bot"+tg+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chat,text:"Threads 新留言\n@"+item.username+"\n"+String(item.body||"").slice(0,1200)}),signal:AbortSignal.timeout(5000)});const d=await rr.json();ok=rr.ok&&d.ok===true;if(!ok)err="telegram_"+rr.status}catch{err="telegram_network"}
 await rpc("threads_patrol_finish",{p_reply_id:item.reply_id,p_lease_id:item.lease_id,p_success:ok,p_error:ok?null:err});if(ok)sent++;else failed++;
 }
 }
 let public_patrol:any={status:"preview"};if(!dry){try{public_patrol=await publicSearch(me.username,service,url,tg,chat)}catch{public_patrol={status:"error"}}}
 return json({public_patrol,mode:input.mode,posts_scanned:posts,post_pages:postPages,reply_pages:replyPages,found,queued,sent,failed,partial,writes:dry?0:queued,elapsed_ms:Date.now()-started});
 }catch(e){return json({error:String(e).slice(0,120),sent:"unknown"},502)}
});
async function publicSearch(username:string,service:string,url:string,tg:string,chat:string){
 const token=env("THREADS_PATROL_V2_ACCESS_TOKEN");if(!token)return {status:"missing_token"};
 const date=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
 const modes=await Promise.all(["RECENT","TOP"].map(async mode=>{try{const q=new URLSearchParams({q:"海巡",search_type:mode,fields:"id,text,timestamp,permalink,username",limit:"50"});const r=await fetch("https://graph.threads.net/v1.0/keyword_search?"+q,{headers:{Authorization:"Bearer "+token},signal:AbortSignal.timeout(6000)});const body=await r.json();return {mode,http:r.status,rows:r.ok&&Array.isArray(body.data)?body.data:[],error_code:body.error?.code||null};}catch{return {mode,http:0,rows:[],error_code:"network"};}}));const d={data:[...new Map(modes.flatMap(m=>m.rows).map((post:any)=>[String(post.id),post])).values()]};const search_modes=modes.map(({mode,http,rows,error_code})=>({mode,http,count:rows.length,error_code}));if(modes.every(m=>m.http!==200))return {status:"search_failed",search_modes};let sent=0,duplicates=0,uncertain=0,eligible=0;const now=Date.now();
 const headers={apikey:service,Authorization:"Bearer "+service,"Content-Type":"application/json",Prefer:"resolution=ignore-duplicates,return=representation"};
 for(const post of (d.data||[])){const id=String(post.id||""),t=Date.parse(post.timestamp);if(!/^\d+$/.test(id)||!post.username||String(post.username).toLowerCase()===String(username).toLowerCase()||!String(post.text||"").includes("海巡")||!Number.isFinite(t)||t>now||t<now-86400000)continue;eligible++;if(sent+uncertain>=10)continue;
 const claim=await fetch(url+"/rest/v1/threads_public_patrol_daily?on_conflict=patrol_date,post_id",{method:"POST",headers,body:JSON.stringify({patrol_date:date,post_id:id,state:"claimed"}),signal:AbortSignal.timeout(5000)});if(!claim.ok)throw Error("claim_failed");if(!(await claim.json()).length){duplicates++;continue}
 let ok=false;try{const rr=await fetch("https://api.telegram.org/bot"+tg+"/sendMessage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chat,text:"Threads 海巡｜新文章\n關鍵字：海巡\n@"+post.username+"\n"+String(post.text).slice(0,1200)+"\n"+String(post.permalink||"")}),signal:AbortSignal.timeout(5000)});ok=rr.ok&&(await rr.json()).ok===true}catch{}
 if(ok)sent++;else uncertain++;await fetch(url+"/rest/v1/threads_public_patrol_daily?patrol_date=eq."+date+"&post_id=eq."+id,{method:"PATCH",headers:{...headers,Prefer:"return=minimal"},body:JSON.stringify({state:ok?"sent":"uncertain"}),signal:AbortSignal.timeout(5000)});
 }return {status:"complete",search_modes,scanned:(d.data||[]).length,eligible,sent,duplicates,uncertain};
}
