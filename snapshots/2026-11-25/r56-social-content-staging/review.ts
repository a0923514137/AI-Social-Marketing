const out=(x:unknown,s=200)=>new Response(JSON.stringify(x),{status:s,headers:{"content-type":"application/json"}});
export default (async(req)=>{
 if(req.method!=="POST")return out({error:"method_not_allowed"},405);
 const key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"",admin=Deno.env.get("THREADS_PATROL_ADMIN_KEY")||"";
 if(!key||!(req.headers.get("authorization")==="Bearer "+key||(admin&&req.headers.get("x-patrol-admin-key")===admin)))return out({error:"unauthorized"},401);
 let x:any;try{x=await req.json()}catch{return out({error:"invalid_json"},400)}
 const mode=String(x.mode||"preview"),date=String(x.date||new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()));
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return out({error:"invalid_date"},400);
 const url=Deno.env.get("SUPABASE_URL")||"",h={apikey:key,Authorization:"Bearer "+key,"content-type":"application/json"};
 if(!url)return out({error:"missing_url"},503);
 const api=async(path:string,method="GET",data?:unknown)=>{const r=await fetch(url+"/rest/v1/"+path,{method,headers:{...h,Prefer:"return=representation"},body:data===undefined?undefined:JSON.stringify(data)});const body=await r.json().catch(()=>null);return {ok:r.ok,status:r.status,body}};
 const rows=await api("r53_draft_reviews?draft_date=eq."+date+"&select=*&order=version.desc&limit=50");
 if(!rows.ok)return out({error:"read_failed",http:rows.status},502);
 const list=rows.body as any[],latest=list[0];
 if(mode==="preview")return out({mode,latest,history:list,buttons:["確認","修改","再次生成","取消"],telegram_sent:false,published:false});
 if(mode==="create"||mode==="regenerate"){
  if(mode==="regenerate"&&!latest)return out({error:"no_previous_draft"},409);
  if(mode==="regenerate"&&latest.status==="approved")return out({error:"approved_draft_locked"},409);
  const body=String(x.body||""),keyword=String(x.keyword||""),reply_text=String(x.reply_text||"");
  if(!body.trim()||!keyword.trim()||!reply_text.trim()||body.length>10000||keyword.length>80||reply_text.length>2000)return out({error:"draft_content_required",note:"GPT generation is not yet connected; supply generated content"},400);
  const r=await api("r53_draft_reviews","POST",{draft_date:date,version:(latest?.version||0)+1,body,keyword,reply_text,status:"pending"});
  return out({mode,created:r.ok,draft:r.body,gpt_generated:false,telegram_sent:false,published:false},r.ok?200:502);
 }
 if(!latest)return out({error:"no_draft"},404);
 if(!["approve","edit","cancel","bind_post"].includes(mode))return out({error:"invalid_mode"},400);
 if(mode==="edit"&&latest.status!=="pending")return out({error:"not_pending"},409);
 if(mode==="bind_post"&&latest.status!=="approved")return out({error:"not_approved"},409);
 if(mode==="bind_post"&&(!["threads","instagram","facebook"].includes(x.platform)||!String(x.post_id||"").trim()))return out({error:"invalid_post_binding"},400);
 if(mode==="bind_post")return out({error:"binding_requires_separate_activation",note:"No automatic keyword activation in R53-06"},409);
 const patch=mode==="approve"?{status:"approved"}:mode==="cancel"?{status:"cancelled"}:{body:String(x.body||latest.body),keyword:String(x.keyword||latest.keyword),reply_text:String(x.reply_text||latest.reply_text)};
 if(mode==="edit"&&(!String(patch.body).trim()||!String(patch.keyword).trim()||!String(patch.reply_text).trim()))return out({error:"empty_fields"},400);
 if(mode==="approve"&&latest.status!=="pending")return out({error:"not_pending"},409);
 const r=await api("r53_draft_reviews?id=eq."+latest.id,"PATCH",patch);
 return out({mode,updated:r.ok,draft:r.body,telegram_sent:false,published:false},r.ok?200:502);
});