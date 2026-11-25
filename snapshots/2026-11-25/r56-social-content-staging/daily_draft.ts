const json=(v:unknown,s=200)=>new Response(JSON.stringify(v),{status:s,headers:{"content-type":"application/json"}});
export default (async req=>{
 if(req.method!=="POST")return json({error:"method_not_allowed"},405);
 const service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
 const admin=Deno.env.get("THREADS_PATROL_ADMIN_KEY")||"";
 const auth=req.headers.get("authorization")||"";
 if(!service||!(auth==="Bearer "+service||(admin&&req.headers.get("x-patrol-admin-key")===admin)))return json({error:"unauthorized"},401);
 let input:{mode?:string}={};try{input=await req.json()}catch{return json({error:"invalid_json"},400)}
 if(input.mode!=="prepare")return json({mode:"preview",schedule:"09:00 Asia/Taipei",publishing:"disabled",approval_required:true});
 const date=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
 const url=Deno.env.get("SUPABASE_URL");
 if(!url)return json({error:"missing_url"},503);
 const r=await fetch(url+"/rest/v1/rpc/threads_r52_prepare_draft",{method:"POST",headers:{"apikey":service,"Authorization":"Bearer "+service,"content-type":"application/json"},body:JSON.stringify({p_date:date})});
 if(!r.ok)return json({error:"prepare_failed",http_status:r.status},502);
 const draft=await r.json();
 return json({mode:"prepare",draft,telegram_sent:false,gpt_generated:false,published:false,reason:"awaiting_gpt_and_telegram_review_integration"});
});