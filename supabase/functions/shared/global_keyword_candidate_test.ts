import { matchGlobalKeyword } from "./global_keyword_candidate.ts";
const row = (keyword: string, global_enabled = true, reply_text = "reply") => ({id: keyword, keyword, global_enabled, reply_text});
Deno.test("matches normalized AI", () => { if (matchGlobalKeyword([row("AI")], "ＡＩ")?.keyword !== "AI") throw Error("match"); });
Deno.test("longest match wins", () => { if (matchGlobalKeyword([row("AI"),row("AI系統")], "AI系統")?.keyword !== "AI系統") throw Error("priority"); });
Deno.test("disabled and empty rules ignored", () => { if (matchGlobalKeyword([row("AI",false),row(""),row("AI",true," ")], "AI")) throw Error("invalid match"); });
Deno.test("no implicit alias", () => { if (matchGlobalKeyword([row("AI")], "系統")) throw Error("alias"); });
