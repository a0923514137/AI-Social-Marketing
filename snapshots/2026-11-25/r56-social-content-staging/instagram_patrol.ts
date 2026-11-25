const reply=(x:unknown,s=200)=>new Response(JSON.stringify(x),{status:s,headers:{"content-type":"application/json"}});
export default (async req=>{
 if(req.method!=="POST")return reply({error:"method_not_allowed"},405);
 const bearer=(req.headers.get("authorization")||"").replace(/^Bearer /,"");
 const service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
 if(!service||!bearer)return reply({error:"unauthorized"},401);
 let role="";try{role=JSON.parse(atob(bearer.split(".")[1].replace(/-/g,"+").replace(/_/g,"/"))).role}catch{}
 if(role!=="service_role")return reply({error:"unauthorized"},401);
 const token=Deno.env.get("INSTAGRAM_ACCESS_TOKEN");if(!token)return reply({status:"missing_token",sends:0,production:"NO_GO"},503);
 const fetchApi=async(path:string)=>{const r=await fetch("https://graph.facebook.com/v22.0/"+path,{headers:{Authorization:"Bearer "+token},signal:AbortSignal.timeout(10000)});const d=await r.json().catch(()=>({}));return {ok:r.ok,status:r.status,data:d}};
 try{
 const media=await fetchApi("17841402364308570/media?fields=id&limit=10");
 if(!media.ok)return reply({status:"media_failed",http:media.status,error_code:media.data?.error?.code||null,sends:0,production:"NO_GO"},502);
 let checked=0,matched=0,failures=0;const matchedIds:string[]=[];
 for(const m of(media.data.data||[])){
 const comments=await fetchApi(m.id+"/comments?fields=id,text&limit=50");
 if(!comments.ok){failures++;continue}
 for(const c of(comments.data.data||[])){checked++;if(/AI/i.test(c.text||"")){matched++;matchedIds.push(c.id)}}
 }
 return reply({status:failures?"partial":"pass",media_count:(media.data.data||[]).length,comments_checked:checked,ai_matches:matched,comment_fetch_failures:failures,matched_comment_ids:matchedIds,sends:0,replies_enabled:false,production:"NO_GO"});
 }catch{return reply({status:"scan_error",sends:0,production:"NO_GO"},502)}
});