const txt=(s:string,status=200)=>new Response(s,{status,headers:{"content-type":"text/plain; charset=utf-8","cache-control":"no-store"}});
const equal=(a:string,b:string)=>{const x=new TextEncoder().encode(a),y=new TextEncoder().encode(b);let d=x.length^y.length;for(let i=0;i<Math.max(x.length,y.length);i++)d|=(x[i]||0)^(y[i]||0);return d===0};
const hex=(b:ArrayBuffer)=>Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,"0")).join("");
Deno.serve(async(req)=>{
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
 const fbId=Deno.env.get("FB_PAGE_ID")||"";
 const igUsername=(Deno.env.get("IG_USERNAME")||"").toLowerCase();
 if(platform==="facebook"&&!/^\d+$/.test(fbId))return txt("missing_page_id",503);
 if(platform==="instagram"&&(!/^\d+$/.test(igId)||!igUsername))return txt("missing_ig_config",503);
 const comments=platform==="facebook"
 ? entries.filter((e:any)=>String(e.id)===fbId).flatMap((e:any)=>(Array.isArray(e.changes)?e.changes:[]).filter((c:any)=>c.field==="feed"&&c.value?.item==="comment"&&c.value?.verb==="add").map((c:any)=>c.value))
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
 let enabled = false;
let replyBaselineAt = NaN;

if (token && service && base) {
  try {
    const r = await fetch(
      base + "/rest/v1/r54_reply_controls?platform=eq." +
      platform + "&select=send_enabled,reply_baseline_at",
      { headers, signal: AbortSignal.timeout(5000) }
    );

    if (r.ok) {
      const control = (await r.json())[0];

      replyBaselineAt = Date.parse(
        control?.reply_baseline_at || ""
      );

      enabled =
        Deno.env.get("SOCIAL_SEND_ENABLED") === "true" &&
        control?.send_enabled === true &&
        Number.isFinite(replyBaselineAt) &&
        replyBaselineAt <= Date.now();
    }
  } catch {
    enabled = false;
  }
}
 const seen=new Set<string>();let matched=0,sent=0;
 for(const c of comments){
   const id=String(c.comment_id||""),author=String(c.from?.id||""),message=String(c.message||"");
   if(!id||!author||author===(platform==="facebook"?fbId:igId)||seen.has(id))continue;
   seen.add(id);
   const match=templates.filter((t:any)=>norm(String(t.keyword||""))&&norm(message).includes(norm(String(t.keyword||"")))).sort((a:any,b:any)=>String(b.keyword).length-String(a.keyword).length)[0];
   if(!match)continue;
 matched++;
  } console.log(JSON.stringify({platform,matched,sends:0})); return txt("EVENT_RECEIVED"); });