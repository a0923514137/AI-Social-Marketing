import facebookPreview from "./facebook_preview.ts";
import threadsPatrol from "./threads_patrol.ts";import threadsScan from "./threads_scan.ts";import instagramPatrol from "./instagram_patrol.ts";import instagramReply from "./instagram_reply.ts";import dailyDraft from "./daily_draft.ts";import review from "./review.ts";
const handlers:Record<string,(r:Request)=>Promise<Response>>={threads_patrol:threadsPatrol,threads_scan:threadsScan,instagram_patrol:instagramPatrol,instagram_reply:instagramReply,daily_draft:dailyDraft,review,facebook_preview:facebookPreview};
const out=(v:unknown,s=200)=>new Response(JSON.stringify(v),{status:s,headers:{"content-type":"application/json"}});
Deno.serve(async req=>{if(req.method!=="POST")return out({error:"method"},405);let role="";try{const t=(req.headers.get("authorization")||"").split(" ")[1];role=JSON.parse(atob(t.split(".")[1].replace(/-/g,"+").replace(/_/g,"/"))).role}catch{}if(role!=="service_role")return out({error:"unauthorized"},401);
let x:any;try{x=await req.json()}catch{return out({error:"invalid_json"},400)}
const task=String(x.task||"preview");if(task==="preview")return out({status:"ready",architecture:"single_edge_function",tasks:Object.keys(handlers),production:"NO_GO",sends:0});
if(!handlers[task])return out({error:"unknown_task"},400);
const body=task==="threads_patrol"?{mode:"run"}:task==="threads_scan"?{mode:"scan"}:task==="daily_draft"?{mode:"prepare"}:task==="review"?(x.payload||{mode:"preview"}):task==="facebook_preview"?(x.payload||{mode:"preview"}):{};
const h=new Headers(req.headers);if(task==="daily_draft"||task==="review"){const key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";h.set("authorization","Bearer "+key)}
try{return await handlers[task](new Request(req.url,{method:"POST",headers:h,body:JSON.stringify(body)}))}catch{return out({error:"handler_failed",task,production:"NO_GO"},502)}
});