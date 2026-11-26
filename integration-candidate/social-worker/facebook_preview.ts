const replyText="謝謝你的留言！我正在分享如何用 GPT 開發自己的系統，歡迎追蹤三明治爸爸，後續會分享實際做法。";
const json=(v:unknown,s=200)=>new Response(JSON.stringify(v),{status:s,headers:{"content-type":"application/json; charset=utf-8"}});
export default async function facebookPreview(req:Request):Promise<Response>{
 if(req.method!=="POST")return json({error:"method_not_allowed"},405);
 let input:any;try{input=await req.json()}catch{return json({error:"invalid_json"},400)}
 const mode=String(input.mode||"preview");
 if(mode==="preview")return json({status:"staging_ready",page:"Yungbo.money",keyword:"系統",matching:"substring",reply_enabled:false,webhook_connected:false,production:"NO_GO"});
 if(mode!=="simulate")return json({error:"unsupported_mode"},400);
 const events=Array.isArray(input.events)?input.events.slice(0,100):[];
 const seen=new Set<string>();const matches:any[]=[];
 for(const event of events){
  const id=String(event?.comment_id||"");const message=String(event?.message||"");
  const page=String(event?.page||"");const author=String(event?.author_id||"");
  if(!id||!page||page!=="Yungbo.money"||author==="Yungbo.money"||!message.includes("系統")||seen.has(id))continue;
  seen.add(id);matches.push({comment_id:id,matched:true,proposed_reply:replyText,action:"dry_run_only"});
 }
 return json({status:"simulated",scanned:events.length,matched:matches.length,matches,sent:0,writes:0,production:"NO_GO"});
}
