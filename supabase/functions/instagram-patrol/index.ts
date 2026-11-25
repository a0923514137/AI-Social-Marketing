const reply=(x:unknown,s=200)=>new Response(JSON.stringify(x),{status:s,headers:{"content-type":"application/json"}});
Deno.serve(async req=>{
 if(req.method!=="POST")return reply({error:"method_not_allowed"},405);
 const key=Deno.env.get("SOCIAL_SCHEDULER_KEY")||"";
 if(key.length<32||req.headers.get("x-social-scheduler-key")!==key)return reply({error:"unauthorized"},401);
 const service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"",base=Deno.env.get("SUPABASE_URL")||"",id=Deno.env.get("IG_BUSINESS_ACCOUNT_ID")||"";
 if(!service||!base||!/^\d+$/.test(id))return reply({error:"missing_configuration"},503);
 const token=Deno.env.get("INSTAGRAM_ACCESS_TOKEN");if(!token)return reply({status:"missing_token",sends:0,production:"NO_GO"},503);
 const fetchApi=async(path:string)=>{const r=await fetch("https://graph.facebook.com/v22.0/"+path,{headers:{Authorization:"Bearer "+token},signal:AbortSignal.timeout(10000)});const d=await r.json().catch(()=>({}));return {ok:r.ok,status:r.status,data:d}};
 try{
 const rules=await fetch(base+"/rest/v1/r54_reply_templates?platform=eq.instagram&select=keyword",{headers:{apikey:service,Authorization:"Bearer "+service},signal:AbortSignal.timeout(5000)});
 if(!rules.ok)return reply({error:"rules_unavailable"},502);
 const norm=(s:string)=>s.normalize("NFKC").trim().toLowerCase();
 const keywords=(await rules.json()).map((r:any)=>norm(String(r.keyword||""))).filter(Boolean);
 const media=await fetchApi(id+"/media?fields=id&limit=10");
 if(!media.ok)return reply({status:"media_failed",http:media.status,error_code:media.data?.error?.code||null,sends:0,production:"NO_GO"},502);
 let checked=0,matched=0,failures=0;const matchedIds:string[]=[];
 for(const m of(media.data.data||[])){
 const comments=await fetchApi(m.id+"/comments?fields=id,text&limit=50");
 if(!comments.ok){failures++;continue}
 for(const c of(comments.data.data||[])){checked++;if(keywords.some((k:string)=>norm(String(c.text||"")).includes(k))){matched++;matchedIds.push(c.id)}}
 }
 return reply({status:failures?"partial":"pass",media_count:(media.data.data||[]).length,comments_checked:checked,keyword_matches:matched,comment_fetch_failures:failures,matched_comment_ids:matchedIds,sends:0,replies_enabled:false,production:"NO_GO"});
 }catch{return reply({status:"scan_error",sends:0,production:"NO_GO"},502)}
});