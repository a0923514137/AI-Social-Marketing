const out=(x:unknown,s=200)=>new Response(JSON.stringify(x),{status:s,headers:{"content-type":"application/json"}});
export default (async (req: Request): Promise<Response> => {
 if(req.method!=="POST")return out({error:"method"},405);
 let role="";try{const t=(req.headers.get("authorization")||"").split(" ")[1];role=JSON.parse(atob(t.split(".")[1].replace(/-/g,"+").replace(/_/g,"/"))).role}catch{}
 if(req.headers.get("authorization")!=="Bearer "+Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"))return out({error:"unauthorized"},401);
 const key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),base=Deno.env.get("SUPABASE_URL"),token=Deno.env.get("INSTAGRAM_ACCESS_TOKEN");
 if(!key||!base||!token)return out({status:"missing_secrets",sent:0},503);
 const rest=async(path:string,method="GET",body?:unknown,prefer?:string)=>{
 const r=await fetch(base+"/rest/v1/"+path,{method,headers:{apikey:key,Authorization:"Bearer "+key,...(body?{"Content-Type":"application/json"}:{}),...(prefer?{Prefer:prefer}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(8000)});
 return {ok:r.ok,status:r.status,data:await r.json().catch(()=>null)};
 };
 const graph=async(path:string,body?:URLSearchParams)=>{
 const r=await fetch("https://graph.facebook.com/v22.0/"+path,{method:body?"POST":"GET",headers:{Authorization:"Bearer "+token,...(body?{"Content-Type":"application/x-www-form-urlencoded"}:{})},body,signal:AbortSignal.timeout(10000)});
 return {ok:r.ok,status:r.status,data:await r.json().catch(()=>({}))};
 };
 try{
 const ctl=await rest("r54_reply_controls?select=send_enabled&platform=eq.instagram");
 if(!ctl.ok)return out({status:"control_unavailable",sent:0},503);
 const enabled=ctl.data?.[0]?.send_enabled===true;
 const tpl=await rest("r53_keyword_rules?select=id,post_id,keyword,reply_text&platform=eq.instagram&enabled=eq.true&order=id.asc");
 if(!tpl.ok||!Array.isArray(tpl.data))return out({status:"template_unavailable",sent:0},503);
 const media=await graph("17841402364308570/media?fields=id&limit=10");
 if(!media.ok)return out({status:"media_error",code:media.data?.error?.code||null,sent:0},502);
 let checked=0,matches=0,sent=0,skipped=0,failed=0,uncertain=0;let scanFailures=0;
 for(const m of(media.data.data||[])){
 const cs=await graph(m.id+"/comments?fields=id,text,username&limit=50");
 if(!cs.ok){scanFailures++;continue}
 for(const c of(cs.data.data||[])){
 checked++;
 if(c.username==="sandwichdadhelp")continue;
 const rule=tpl.data.find((r:any)=>String(r.post_id)===String(m.id)&&typeof r.keyword==="string"&&r.keyword.trim()&&typeof r.reply_text==="string"&&r.reply_text.trim()&&String(c.text||"").toLowerCase().includes(r.keyword.toLowerCase()));
 if(!rule)continue;
 matches++;
 // Live delivery remains unreachable from the preview-only worker router.
 if (!enabled || Deno.env.get("SOCIAL_IG_SEND_ENABLED") !== "true" || req.headers.get("x-internal-delivery-mode") !== "run") { skipped++; continue; }
 const claim=await rest("r54_reply_claims?on_conflict=platform,comment_id","POST",{platform:"instagram",comment_id:c.id,post_id:m.id,rule_id:rule.id,state:"reserved"},"resolution=ignore-duplicates,return=representation");
 if(!claim.ok){failed++;continue}
 if(!Array.isArray(claim.data)||claim.data.length!==1){skipped++;continue}
 const path="r54_reply_claims?platform=eq.instagram&comment_id=eq."+encodeURIComponent(c.id);
 const mark=await rest(path+"&state=eq.reserved","PATCH",{state:"sending",updated_at:new Date().toISOString()},"return=representation");
 if(!mark.ok||!Array.isArray(mark.data)||mark.data.length!==1){failed++;continue}
 let state="uncertain",responseId=null,errorCode="network_unknown";
 try{
 const result=await graph(c.id+"/replies",new URLSearchParams({message:rule.reply_text}));
 if(result.ok&&result.data?.id){state="sent";responseId=result.data.id;errorCode="";}
 else if(!result.ok&&result.status>=400&&result.status<500&&result.status!==408&&result.status!==429){state="failed";errorCode=String(result.status);}
 }catch{/* Do not retry ambiguous delivery. */}
 const recorded=await rest(path+"&state=eq.sending","PATCH",{state,response_id:responseId,error_code:errorCode||null,updated_at:new Date().toISOString()},"return=representation").catch(()=>null);
 if(state==="sent")sent++;else if(state==="failed")failed++;else uncertain++;
 if(!recorded?.ok||!Array.isArray(recorded.data)||recorded.data.length!==1)uncertain++;
 }
 }
 return out({status:failed||uncertain||scanFailures?"partial":"pass",checked,matches,sent,skipped,failed,uncertain,scanFailures,enabled,preview_only:true,production:"NO_GO"});
 }catch{return out({status:"internal_error",production:"NO_GO"},502)}
});