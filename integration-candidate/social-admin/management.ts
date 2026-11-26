import {type Command,MENU} from "./commands.ts";
export async function management(command:Command,base:string,service:string):Promise<string>{
 if(command.action==="menu"||command.action==="invalid")return MENU;
 if(command.action==="list"){
 const r=await fetch(base+"/rest/v1/r54_reply_templates?select=platform,keyword,reply_text&order=platform,keyword&limit=100",{headers:{apikey:service,Authorization:"Bearer "+service},signal:AbortSignal.timeout(5000)});
 if(!r.ok)throw new Error("template_read_failed");
 const rows=await r.json() as {platform:string;keyword:string;reply_text:string}[];
 return rows.map(r=>r.platform+"｜"+r.keyword+"｜"+r.reply_text).join("\n")||"尚無關鍵字";
 }
 return "候選預覽：/"+command.action+"，尚未啟用資料庫修改。";
}
