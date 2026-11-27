import { canReply, type Platform } from "./reply_gate_candidate.ts";
const base = {platform:"youtube" as Platform,mode:"run",globalEnabled:true,platformEnabled:true,environmentEnabled:true,activation:"2026-11-27T00:00:00Z",publishedAt:"2026-11-27T00:01:00Z",now:Date.parse("2026-11-27T00:02:00Z")};
Deno.test("valid live modes",()=>{for(const [platform,mode] of Object.entries({facebook:"webhook",instagram:"run",threads:"scan",youtube:"run"}))if(!canReply({...base,platform:platform as Platform,mode}))throw Error(platform);});
Deno.test("all gates fail closed",()=>{for(const key of ["globalEnabled","platformEnabled","environmentEnabled"])if(canReply({...base,[key]:false}))throw Error(key);});
Deno.test("preview never sends",()=>{for(const mode of ["preview","scan_preview","run_preview"])if(canReply({...base,mode}))throw Error(mode);});
Deno.test("reject historical, future and invalid dates",()=>{for(const publishedAt of [base.activation,"2026-11-28T00:00:00Z","invalid"])if(canReply({...base,publishedAt}))throw Error(publishedAt);});
