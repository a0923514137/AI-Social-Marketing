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
