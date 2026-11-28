
const j=(x:unknown,s=200)=>new Response(JSON.stringify(x),{status:s,headers:{"content-type":"application/json"}});
export async function handleReview(req: Request): Promise<Response> {
 if(req.method!=="POST")return j({error:"method_not_allowed"},405);
 const service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"",admin=Deno.env.get("THREADS_PATROL_ADMIN_KEY")||"";
 if(!service||!(req.headers.get("authorization")==="Bearer "+service||(admin&&req.headers.get("x-patrol-admin-key")===admin)))return j({error:"unauthorized"},401);
 let x:any;try{x=await req.json()}catch{return j({error:"invalid_json"},400)}
 const mode=String(x.mode||"preview"),url=Deno.env.get("SUPABASE_URL")||"";
 const owner=Deno.env.get("R53_TELEGRAM_ADMIN_ID")||"",chat=Deno.env.get("R53_TELEGRAM_CHAT_ID")||"",bot=Deno.env.get("TELEGRAM_BOT_TOKEN")||"";
 if(!url)return j({error:"missing_url"},503);
 const h={apikey:service,Authorization:"Bearer "+service,"content-type":"application/json"};
 const db=async(path:string,method="GET",body?:unknown,prefer="return=representation")=>{
  const r=await fetch(url+"/rest/v1/"+path,{method,headers:{...h,Prefer:prefer},body:body===undefined?undefined:JSON.stringify(body)});
  return {ok:r.ok,status:r.status,data:await r.json().catch(()=>null)};
 };
 const send=async(text:string,buttons?:any)=>{
  if (Deno.env.get("SOCIAL_TELEGRAM_ENABLED") !== "true" || !bot || !chat) {
    return false;
  }
  const r=await fetch("https://api.telegram.org/bot"+bot+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chat,text,reply_markup:buttons?{inline_keyboard:buttons}:undefined})});
  return r.ok;
 };
 const id=String(x.draft_id||"");
 if(mode==="preview")return j({mode,buttons:["確認","修改","再次生成","取消"],telegram_configured:!!(owner&&chat&&bot),gpt_configured:!!Deno.env.get("OPENAI_API_KEY"),published:false});
 if(mode==="process_message"){
  const u=x.update,uid=String(u?.message?.from?.id||"");
  if(!owner||uid!==owner||(chat&&String(u?.message?.chat?.id)!==chat))return j({error:"unauthorized_sender"},403);
  const text=String(u?.message?.text||"");
  if(!Number.isSafeInteger(u?.update_id)||!text.trim()||text.length>10000)return j({error:"invalid_message"},400);
  const pending=await db("r53_telegram_pending_edits?telegram_user_id=eq."+uid+"&select=draft_id");
  if(!pending.ok||!pending.data?.length)return j({ignored:true,reason:"no_pending_edit"});
  const draftId=pending.data[0].draft_id;
  const event=await db("r53_telegram_review_events?on_conflict=update_id","POST",{update_id:u.update_id,draft_id:draftId,telegram_user_id:uid,action:"edit",result:"received"},"resolution=ignore-duplicates,return=representation");
  if(!event.ok)return j({error:"event_failed"},502);
  if(!event.data?.length)return j({duplicate:true});
  const changed=await db("r53_draft_reviews?id=eq."+draftId+"&status=eq.pending","PATCH",{body:text});
  if(changed.ok&&changed.data?.length)await db("r53_telegram_pending_edits?telegram_user_id=eq."+uid,"DELETE");
  return j({mode,updated:changed.ok&&changed.data?.length===1,telegram_notified:changed.ok?await send("草稿已修改，請重新預覽並確認"):false,published:false});
 }
 if(!/^[0-9a-f-]{36}$/i.test(id))return j({error:"invalid_draft_id"},400);
 const r=await db("r53_draft_reviews?id=eq."+id+"&select=*&limit=1");
 if(!r.ok||!r.data?.length)return j({error:"draft_not_found"},404);
 const draft=r.data[0];
 if(mode==="send_preview"){
  if(!owner||!chat||!bot)return j({error:"telegram_configuration_missing"},503);
  const buttons=[["確認","approve"],["修改","edit"],["再次生成","regenerate"],["取消","cancel"]].map(([label,action])=>[{text:label,callback_data:"r53:"+action+":"+id}]);
  return j({mode,sent:await send("R53 Staging 草稿 v"+draft.version+"\n"+draft.body+"\n關鍵字："+draft.keyword+"\n回覆："+draft.reply_text+"\n不自動發文",buttons),published:false});
 }
 if(mode!=="process_update")return j({error:"unsupported_mode"},400);
 const u=x.update,cb=u?.callback_query,uid=String(cb?.from?.id||"");
 if(!owner||uid!==owner||(chat&&String(cb?.message?.chat?.id)!==chat)||!Number.isSafeInteger(u?.update_id))return j({error:"unauthorized_update"},403);
 const m=/^r53:(approve|edit|regenerate|cancel):([0-9a-f-]{36})$/i.exec(String(cb?.data||""));
 if(!m||m[2]!==id)return j({error:"invalid_callback"},400);
 const action=m[1];
 const event=await db("r53_telegram_review_events?on_conflict=update_id","POST",{update_id:u.update_id,draft_id:id,telegram_user_id:uid,action,result:"received"},"resolution=ignore-duplicates,return=representation");
 if(!event.ok)return j({error:"event_failed"},502);
 if(!event.data?.length)return j({duplicate:true,updated:false});
 if(draft.status!=="pending")return j({updated:false,reason:"not_pending"});
 if(action==="edit"){
  const saved=await db("r53_telegram_pending_edits?on_conflict=telegram_user_id","POST",{telegram_user_id:uid,draft_id:id},"resolution=merge-duplicates,return=representation");
  return j({action,ready:saved.ok,notified:saved.ok?await send("請直接傳送修改後的完整貼文文字。"):false});
 }
 if(action==="regenerate"){
  const key=Deno.env.get("OPENAI_API_KEY")||"";
  if(!key)return j({action,generated:false,reason:"openai_key_not_configured"});
  const ai=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{Authorization:"Bearer "+key,"content-type":"application/json"},body:JSON.stringify({model:"gpt-4.1-mini",input:"請以繁體中文重新撰寫這篇社群貼文，保留真實性，不編造個人經歷。只輸出貼文內文，不要附加說明。原文："+draft.body})});
  const data=await ai.json().catch(()=>null);
  const body=String(data?.output?.flatMap((o:any)=>o.content||[]).filter((c:any)=>c.type==="output_text").map((c:any)=>c.text).join("\n")||"");
  if(!ai.ok||!body.trim())return j({generated:false,error:"gpt_generation_failed"},502);
  const next=await db("r53_draft_reviews","POST",{draft_date:draft.draft_date,version:draft.version+1,body,keyword:draft.keyword,reply_text:draft.reply_text,status:"pending"});
  if(!next.ok)return j({generated:true,saved:false,error:"version_conflict_or_insert_failed"},409);
  return j({generated:true,saved:true,version:draft.version+1,notified:await send("新版本已生成 v"+(draft.version+1)+"，請重新預覽審核"),published:false});
 }
 const changed=await db("r53_draft_reviews?id=eq."+id+"&status=eq.pending","PATCH",{status:action==="approve"?"approved":"cancelled"});
 return j({action,updated:changed.ok&&changed.data?.length===1,notified:changed.ok?await send(action==="approve"?"草稿已核准（尚未發布）":"草稿已取消"):false,published:false});
}
