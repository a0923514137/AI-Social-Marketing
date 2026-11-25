const out=(x:unknown,s=200)=>new Response(JSON.stringify(x),{status:s,headers:{"content-type":"application/json"}});
export default (async req=>{
 if(req.method!=="POST")return out({error:"method"},405);
 let role="";try{const t=(req.headers.get("authorization")||"").split(" ")[1];role=JSON.parse(atob(t.split(".")[1].replace(/-/g,"+").replace(/_/g,"/"))).role}catch{}
 if(role!=="service_role")return out({error:"unauthorized"},401);
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
 if(!ctl.data?.[0]?.send_enabled)return out({status:"disabled",sent:0,production:"NO_GO"});
 const tpl=await rest("r54_reply_templates?select=keyword,reply_text&platform=eq.instagram&template_key=eq.default_ai");
 if(!tpl.ok||!tpl.data?.[0]?.reply_text)return out({status:"template_unavailable",sent:0},503);
 const media=await graph("17841402364308570/media?fields=id&limit=10");
 if(!media.ok)return out({status:"media_error",code:media.data?.error?.code||null,sent:0},502);
 let checked=0,matches=0,sent=0,skipped=0,failed=0,uncertain=0;let scanFailures=0;
 for(const m of(media.data.data||[])){
 const cs=await graph(m.id+"/comments?fields=id,text,username&limit=50");
 if(!cs.ok){scanFailures++;continue}
 for(const c of(cs.data.data||[])){
 checked++;
 if(c.username==="sandwichdadhelp"||!/(^|[^a-z])ai([^a-z]|$)/i.test(c.text||""))continue;
 matches++;
 const claim=await rest("r54_reply_claims?on_conflict=platform,comment_id","POST",{platform:"instagram",comment_id:c.id,post_id:m.id,state:"reserved"},"resolution=ignore-duplicates,return=representation");
 if(!claim.ok){failed++;continue}
 if(!Array.isArray(claim.data)||claim.data.length===0){skipped++;continue}
 const mark=await rest("r54_reply_claims?platform=eq.instagram&comment_id=eq."+encodeURIComponent(c.id),"PATCH",{state:"sending",updated_at:new Date().toISOString()},"return=minimal");
 if(!mark.ok){failed++;continue}
 let result:{ok:boolean;status:number;data:any};
 try{result=await graph(c.id+"/replies",new URLSearchParams({message:tpl.data[0].reply_text}))}
 catch{uncertain++;await rest("r54_reply_claims?platform=eq.instagram&comment_id=eq."+encodeURIComponent(c.id),"PATCH",{state:"uncertain",error_code:"network_unknown",updated_at:new Date().toISOString()},"return=minimal").catch(()=>{});continue}
 const state=result.ok&&result.data?.id?"sent":result.ok?"uncertain":"failed";
 const record=await rest("r54_reply_claims?platform=eq.instagram&comment_id=eq."+encodeURIComponent(c.id),"PATCH",{state,response_id:result.data?.id||null,error_code:result.ok?null:String(result.data?.error?.code||result.status),updated_at:new Date().toISOString()},"return=minimal");
 if(state==="sent")sent++;else if(state==="uncertain")uncertain++;else failed++;
 if(!record.ok)uncertain++;
 }
 }
 return out({status:failed||uncertain||scanFailures?"partial":"pass",checked,matches,sent,skipped,failed,uncertain,scanFailures,production:"NO_GO"});
 }catch{return out({status:"internal_error",production:"NO_GO"},502)}
});