const txt=(s:string,status=200)=>new Response(s,{status,headers:{"content-type":"text/plain; charset=utf-8","cache-control":"no-store"}});
const equal=(a:string,b:string)=>{const x=new TextEncoder().encode(a),y=new TextEncoder().encode(b);let d=x.length^y.length;for(let i=0;i<Math.max(x.length,y.length);i++)d|=(x[i]||0)^(y[i]||0);return d===0};
const hex=(b:ArrayBuffer)=>Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,"0")).join("");
export async function handleWebhook(req: Request): Promise<Response> {
 const verify=Deno.env.get("FB_WEBHOOK_VERIFY_TOKEN")||"";
 const appSecret=Deno.env.get("FB_APP_SECRET")||"";
 if(req.method==="GET"){
  const u=new URL(req.url),mode=u.searchParams.get("hub.mode")||"",token=u.searchParams.get("hub.verify_token")||"",challenge=u.searchParams.get("hub.challenge")||"";
  if(!verify||mode!=="subscribe"||!token||!equal(token,verify)||!challenge)return txt("verification_failed",403);
  return txt(challenge);
 }
 if(req.method!=="POST")return txt("method_not_allowed",405);
 const igSecret=Deno.env.get("IG_APP_SECRET")||"";
 const sig=req.headers.get("x-hub-signature-256")||"";
 if(!/^sha256=[a-f0-9]{64}$/i.test(sig)){console.log("r82_signature_missing_or_malformed");return txt("invalid_signature",403);}
 const raw=await req.arrayBuffer();
 if(raw.byteLength>1024*1024)return txt("payload_too_large",413);
 let data:any;try{data=JSON.parse(new TextDecoder().decode(raw))}catch{return txt("invalid_json",400)}
 const secret=data?.object==="instagram"?igSecret:data?.object==="page"?appSecret:"";
 if(!secret){console.log("r82_platform_secret_missing_or_unsupported");return txt("webhook_not_configured",503);}
 const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const expected="sha256="+hex(await crypto.subtle.sign("HMAC",key,raw));
 if(!equal(sig.toLowerCase(),expected)){console.log("r82_signature_mismatch");return txt("invalid_signature",403);}
 if(!["page","instagram"].includes(String(data?.object||"")))return txt("unsupported_object",400);
 // R58 Staging: verified Meta events -> R56 facebook_preview, dry run only.
 const entries=Array.isArray(data.entry)?data.entry:[];
 const feedChanges=entries.flatMap((e:any)=>Array.isArray(e.changes)?e.changes:[]).filter((c:any)=>c.field==="feed");
 const platform=data.object==="instagram"?"instagram":"facebook";
 const igId=Deno.env.get("IG_BUSINESS_ACCOUNT_ID")||"";
 const comments=platform==="facebook"
 ? entries.filter((e:any)=>String(e.id)==="1372124255993564").flatMap((e:any)=>(Array.isArray(e.changes)?e.changes:[]).filter((c:any)=>c.field==="feed"&&c.value?.item==="comment"&&c.value?.verb==="add").map((c:any)=>c.value))
 : entries.filter((e:any)=>!!igId&&String(e.id)===igId).flatMap((e:any)=>(Array.isArray(e.changes)?e.changes:[]).filter((c:any)=>c.field==="comments").map((c:any)=>({comment_id:c.value?.id,from:{id:c.value?.from?.id},message:c.value?.text,post_id:c.value?.media?.id,parent_id:c.value?.parent_id,username:c.value?.from?.username,self_id:c.value?.from?.self_ig_scoped_id})));
 const service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
 const base=Deno.env.get("SUPABASE_URL")||"";
 let templates:any[]=[];
 if(service&&base){
   try{
     const rr=await fetch(base+"/rest/v1/r54_reply_templates?platform=eq."+platform+"&select=template_key,keyword,reply_text",{headers:{apikey:service,Authorization:"Bearer "+service},signal:AbortSignal.timeout(6000)});
     if(rr.ok)templates=await rr.json();else console.log(JSON.stringify({event:"r79_template_read_failed",http:rr.status}));
   }catch{console.log(JSON.stringify({event:"r79_template_network_error"}));}
 }
 const norm=(s:string)=>s.normalize("NFKC").toLocaleLowerCase().trim();
 const headers={apikey:service,Authorization:"Bearer "+service,"Content-Type":"application/json"};
 const token=Deno.env.get(platform==="instagram"?"INSTAGRAM_ACCESS_TOKEN":"FB_PAGE_ACCESS_TOKEN")||"";
 let enabled=false;
 if(token&&service&&base){try{const r=await fetch(base+"/rest/v1/r54_reply_controls?platform=eq."+platform+"&select=send_enabled",{headers,signal:AbortSignal.timeout(5000)});enabled=r.ok&&(await r.json())[0]?.send_enabled===true}catch{}}
 const seen=new Set<string>();let matched=0,sent=0;
 for(const c of comments){
   const id=String(c.comment_id||""),author=String(c.from?.id||""),message=String(c.message||"");
   if(!id||!author||author===(platform==="facebook"?"1372124255993564":igId)||seen.has(id))continue;
   seen.add(id);
   const match=templates.filter((t:any)=>norm(String(t.keyword||""))&&norm(message).includes(norm(String(t.keyword||"")))).sort((a:any,b:any)=>String(b.keyword).length-String(a.keyword).length)[0];
   if(!match)continue;
 matched++;
 // Candidate hard lock: no claims or delivery.
 if(!enabled || !candidateDeliveryAllowed())continue;
 if(platform==="instagram"&&(!/^\d+$/.test(id)||!/^\d+$/.test(String(c.post_id||""))||c.parent_id||String(c.username||"").toLowerCase()==="sandwichdadhelp"||(c.self_id&&String(c.self_id)===author)))continue;
 if(platform==="facebook"&&(!/^\d+(_\d+)?$/.test(id)||!/^1372124255993564_\d+$/.test(String(c.post_id||""))||(c.parent_id&&String(c.parent_id)!==String(c.post_id))))continue;
 const endpoint=base+"/rest/v1/r54_reply_claims";
 try{
 const claim=await fetch(endpoint+"?on_conflict=platform,comment_id",{method:"POST",headers:{...headers,Prefer:"resolution=ignore-duplicates,return=representation"},body:JSON.stringify({platform,comment_id:id,post_id:String(c.post_id),state:"sending"}),signal:AbortSignal.timeout(5000)});
 if(!claim.ok){console.log(JSON.stringify({event:"r83_claim_failed",http:claim.status}));continue;}
 if(!(await claim.json()).length)continue;
 let state="uncertain",response_id=null,error_code=null;
 try{
 const rr=await fetch("https://graph.facebook.com/v22.0/"+id+(platform==="instagram"?"/replies":"/comments"),{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({message:match.reply_text}),signal:AbortSignal.timeout(8000)});
 const result=await rr.json();
 if(rr.ok&&result.id){state="sent";response_id=String(result.id);sent++;}
 else{state=rr.status>=500?"uncertain":"failed";error_code=String(result.error?.code||rr.status);}
 }catch{error_code="transport_uncertain";}
 const update=await fetch(endpoint+"?platform=eq."+platform+"&comment_id=eq."+id,{method:"PATCH",headers,body:JSON.stringify({state,response_id,error_code,updated_at:new Date().toISOString()}),signal:AbortSignal.timeout(5000)});
 console.log(JSON.stringify({event:"r83_ig_reply",platform,comment_id:id,state,error_code,ledger_http:update.status}));
 }catch{console.log(JSON.stringify({event:"r83_claim_or_update_uncertain",comment_id:id}));}

 }
 console.log(JSON.stringify({event:"r80_meta_webhook_preview",platform,comment_events:comments.length,unique_comments:seen.size,matched,templates:templates.length,mode:enabled?platform+"_live":"staging_preview_only",sends:sent,production:"NO_GO"}));
 console.log(JSON.stringify({event:"fb_webhook_verified",entry_count:entries.length,mode:enabled?platform+"_live":"staging_receive_only",sends:sent}));
 return txt("EVENT_RECEIVED");
}
function candidateDeliveryAllowed(): boolean { return false; }
if (import.meta.main) Deno.serve(handleWebhook);
