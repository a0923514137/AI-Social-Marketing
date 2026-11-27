import { createYoutubePreview } from "./youtube.ts";
const now = Date.parse("2026-11-27T12:00:00Z");
const values: Record<string,string> = {
  SUPABASE_URL: "https://vnvrkbeyrhatbnjhglmv.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "mock",
  SOCIAL_SEND_ENABLED: "true", YOUTUBE_SEND_ENABLED: "true",
  YOUTUBE_CHANNEL_ID: "mock-channel",
};
for (const row of [
  [], [{enabled:false,activated_at:"2026-11-27T10:00:00Z"}],
  [{enabled:true,activated_at:null}],
  [{enabled:true,activated_at:"2026-11-28T00:00:00Z"}],
]) {
  Deno.test("YouTube fails closed: "+JSON.stringify(row), async () => {
    const calls: string[] = [];
    const request: typeof fetch = async (input) => {
      const url = String(input); calls.push(url);
      if(url.includes("/rpc/r130_youtube_setup")) return Response.json({baseline_at:"2026-11-27T09:00:00Z",send_enabled:true});
      if(url.includes("/social_reply_switch?")) return Response.json(row);
      throw Error("unexpected request");
    };
    const poll = createYoutubePreview({env:k=>values[k],request,clock:()=>now});
    let error = "";
    try { await poll("run"); } catch(e) { error = (e as Error).message; }
    if(error !== "youtube_send_disabled" || calls.length !== 2) throw Error("gate failed: "+error);
  });
}
Deno.test("environment off blocks all network calls", async()=>{
  const poll=createYoutubePreview({env:k=>k==="SOCIAL_SEND_ENABLED"?"false":values[k],request:async()=>{throw Error("network called");},clock:()=>now});
  let error="";try{await poll("run");}catch(e){error=(e as Error).message;}
  if(error!=="youtube_send_disabled")throw Error(error);
});

Deno.test("preview skips historical, self, duplicate and already replied comments", async()=>{
  const make=(id:string, publishedAt:string, author="other", totalReplyCount=0)=>({snippet:{canReply:true,totalReplyCount,topLevelComment:{id,snippet:{authorChannelId:{value:author},publishedAt,textDisplay:"自動化"}}}});
  const recent="2026-11-27T11:00:00Z";
  const calls:string[]=[];
  const request:typeof fetch=async(input,init)=>{
    const url=String(input);calls.push(url);
    if(url.includes("/rpc/r130_youtube_setup"))return Response.json({baseline_at:"2026-11-27T09:00:00Z",send_enabled:false});
    if(url.includes("oauth2.googleapis.com/token"))return Response.json({access_token:"mock",expires_in:3600});
    if(url.includes("/rpc/r130_youtube_reserve"))return Response.json({status:"reserved",quota_day:"2026-11-27"});
    if(url.includes("/channels?"))return Response.json({items:[{id:"mock-channel"}]});
    if(url.includes("/social_keywords?"))return Response.json([{id:"rule",keyword:"自動化",reply_text:"謝謝",global_enabled:true}]);
    if(url.includes("/commentThreads?"))return Response.json({items:[make("old","2026-11-27T09:00:00Z"),make("self",recent,"mock-channel"),make("replied",recent,"other",1),make("new",recent),make("new",recent)]});
    throw Error("unexpected request "+init?.method);
  };
  const poll=createYoutubePreview({env:k=>({...values,YOUTUBE_CLIENT_ID:"mock",YOUTUBE_CLIENT_SECRET:"mock",YOUTUBE_REFRESH_TOKEN:"mock"} as Record<string,string>)[k],request,clock:()=>now});
  const result=await poll("preview");
  if(result.sends!==0 || result.candidates.length!==1 || result.candidates[0].comment_id!=="new" || result.skipped.historical!==1 || result.skipped.self!==1 || result.skipped.duplicate!==2)throw Error("preview filtering regression");
  if(calls.some(u=>u.includes("/comments?")))throw Error("unexpected delivery");
});
