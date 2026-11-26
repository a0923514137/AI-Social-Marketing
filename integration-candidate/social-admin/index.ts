import {management} from "./management.ts";
import {parseCommand} from "./commands.ts";
import {handleReview} from "./review.ts";
const j=(x:unknown,s=200)=>new Response(JSON.stringify(x),{status:s,headers:{"content-type":"application/json"}});
export async function handleAdmin(req: Request): Promise<Response> {
 if(req.method!=="POST")return j({error:"method_not_allowed"},405);
 const secret=Deno.env.get("R53_TELEGRAM_WEBHOOK_SECRET")||"";
 const owner=Deno.env.get("R53_TELEGRAM_ADMIN_ID")||"";
 const chat=Deno.env.get("R53_TELEGRAM_CHAT_ID")||"";
 const service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
 const url=Deno.env.get("SUPABASE_URL")||"";
 if(!secret||!owner||!chat||!service||!url)return j({error:"not_configured"},503);
 if(req.headers.get("x-telegram-bot-api-secret-token")!==secret)return j({error:"unauthorized"},401);
 let u:any;try{u=await req.json()}catch{return j({error:"invalid_json"},400)}
 const cb=u?.callback_query, msg=u?.message;
 const sender=String(cb?.from?.id||msg?.from?.id||"");
 const chatId=String(cb?.message?.chat?.id||msg?.chat?.id||"");
 if(sender!==owner||chatId!==chat)return j({ignored:true});
 if(!Number.isSafeInteger(u?.update_id))return j({error:"invalid_update"},400);
 if(!cb && typeof msg?.text==="string"){
 const command=parseCommand(msg.text);
 if(command.action!=="other"){
 try{
 const message=await management(command,url,service);
 const bot=Deno.env.get("TELEGRAM_BOT_TOKEN")||"";
 if(!bot)return j({error:"bot_not_configured"},503);
 const chars=Array.from(message);
 for(let i=0;i<chars.length;i+=3000){
 const r=await fetch("https://api.telegram.org/bot"+bot+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chat,text:chars.slice(i,i+3000).join("")}),signal:AbortSignal.timeout(8000)});
 if(!r.ok)return j({error:"telegram_send_failed"},502);
 }
 return j({accepted:true,action:command.action,writes:0,notified:true});
 }catch{return j({error:"management_failed"},502);}
 }
 }
 const data=String(cb?.data||"");
 const match=/^r53:(approve|edit|regenerate|cancel):([0-9a-f-]{36})$/i.exec(data);
 if(cb&&!match)return j({ignored:true});
 const id=match?.[2]||"";
 const endpoint=req.url;
 let draftId=id;
 if(!cb){
  if(!msg?.text)return j({ignored:true});
  const h={apikey:service,Authorization:"Bearer "+service};
  const r=await fetch(url+"/rest/v1/r53_telegram_pending_edits?telegram_user_id=eq."+owner+"&select=draft_id&limit=1",{headers:h});
  const rows=await r.json().catch(()=>[]);
  if(!r.ok)return j({error:"pending_lookup_failed"},502);
  if(!rows?.length)return j({ignored:true});
  draftId=rows[0].draft_id;
 }
 const r=await handleReview(new Request(endpoint,{method:"POST",headers:{Authorization:"Bearer "+service,"content-type":"application/json"},body:JSON.stringify({mode:cb?"process_update":"process_message",draft_id:draftId,update:u})}));
 const result=await r.json().catch(()=>null);
 return j({accepted:r.ok,processed:result?.updated===true||result?.ready===true||result?.generated===true,duplicate:result?.duplicate===true,error:r.ok?undefined:"handler_failed"},r.ok?200:502);
}
if(import.meta.main) Deno.serve(handleAdmin);
