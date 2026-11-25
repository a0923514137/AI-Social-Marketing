const schedulerRole=(req:Request)=>{const key=Deno.env.get("SOCIAL_SCHEDULER_KEY")||"";return key.length>=32&&req.headers.get("x-social-scheduler-key")===key};
const out=(x:unknown,s=200)=>new Response(JSON.stringify(x),{status:s,headers:{"content-type":"application/json","cache-control":"no-store"}});
export default (async(req: Request)=>{
 if(req.method!=="POST")return out({error:"method_not_allowed"},405);
 const key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
 if(!key||!schedulerRole(req))return out({error:"unauthorized"},401);
 let x:any;try{x=await req.json()}catch{return out({error:"invalid_json"},400)}
 const mode=String(x.mode||"preview");if(!["preview","scan"].includes(mode))return out({error:"invalid_mode"},400);
 const token=Deno.env.get("THREADS_ACCESS_TOKEN")||"",base=Deno.env.get("SUPABASE_URL")||"";
 if(!token||!base)return out({error:"missing_configuration"},503);
 const headers={apikey:key,Authorization:"Bearer "+key,"content-type":"application/json"};
 const db=async(path:string,method="GET",body?:unknown,prefer="return=representation")=>{
 const r=await fetch(base+"/rest/v1/"+path,{method,headers:{...headers,Prefer:prefer},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(6000)});
 return {ok:r.ok,status:r.status,rows:await r.json().catch(()=>[])};
 };
 const control=await db("r54_reply_controls?platform=eq.threads&select=send_enabled");
 if(!control.ok)return out({error:"control_unavailable"},502);
 const enabled=Deno.env.get("SOCIAL_SEND_ENABLED")==="true"&&control.rows[0]?.send_enabled===true;
 if(mode==="preview")return out({mode,configured:true,db_send_enabled:enabled,scan_supported:true,external_sends:0,production:"NO_GO"});
 if(!enabled)return out({error:"send_disabled",sent:0},403);
 const rules=await db("r54_reply_templates?platform=eq.threads&select=keyword,reply_text");
 if(!rules.ok)return out({error:"rules_unavailable"},502);
 const norm=(v:string)=>v.normalize("NFKC").trim().toLowerCase();
 const api=async(path:string)=>{const r=await fetch("https://graph.threads.net/v1.0/"+path,{headers:{Authorization:"Bearer "+token},signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error("threads_http_"+r.status);return r.json()};
 let me:any;try{me=await api("me?fields=id,username")}catch{return out({error:"threads_identity_failed",sent:0},502)}
 let scanned=0,matched=0,sent=0,skipped=0,uncertain=0;
 let posts:any;try{posts=await api("me/threads?fields=id,timestamp&limit=10")}catch{return out({error:"threads_posts_failed",sent:0},502)}
 for(const target of (posts.data||[]).slice(0,10)){
  const post=String(target.id||"");if(!/^[0-9]+$/.test(post))continue;
  let page:any;try{page=await api(post+"/replies?fields=id,text,username&limit=50")}catch{continue}
  for(const c of (page.data||[]).slice(0,50)){
   scanned++;const comment=String(c.id||"");
   if(!/^[0-9]+$/.test(comment)||!c.username||norm(String(c.username||""))===norm(String(me.username||""))){skipped++;continue}
   const rule=rules.rows.slice().sort((a:any,b:any)=>String(b.keyword).length-String(a.keyword).length).find((r:any)=>norm(String(c.text||"")).includes(norm(String(r.keyword||"")))&&String(r.keyword||"").trim());
   if(!rule)continue;matched++;
   const claim=await db("r54_reply_claims?on_conflict=platform,comment_id","POST",{platform:"threads",comment_id:comment,post_id:post,state:"sending"},"resolution=ignore-duplicates,return=representation");
   if(!claim.ok||!claim.rows?.length){skipped++;continue}
   const mark=async(state:string,response_id?:string,error_code?:string)=>db("r54_reply_claims?platform=eq.threads&comment_id=eq."+comment,"PATCH",{state,response_id:response_id||null,error_code:error_code||null,updated_at:new Date().toISOString()});
   try{
    const form=new URLSearchParams({media_type:"TEXT",text:String(rule.reply_text),reply_to_id:comment,auto_publish_text:"true"});
    const r=await fetch("https://graph.threads.net/v1.0/me/threads",{method:"POST",headers:{Authorization:"Bearer "+token,"content-type":"application/x-www-form-urlencoded"},body:form,signal:AbortSignal.timeout(10000)});
    const result=await r.json().catch(()=>null);
    if(!r.ok||!result?.id){await mark("uncertain",undefined,"threads_http_"+r.status);uncertain++;continue}
    await mark("sent",String(result.id));sent++;
   }catch{await mark("uncertain",undefined,"network_unknown");uncertain++}
  }
 }
 return out({mode,scanned,matched,sent,skipped,uncertain,production:"NO_GO"});
});