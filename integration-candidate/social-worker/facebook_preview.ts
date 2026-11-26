import { matchRule, socialDatabase } from "../shared/social.ts";

export default async function facebookPreview(req: Request) {
  const base = Deno.env.get("SUPABASE_URL");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const page = Deno.env.get("FB_PAGE_ID");
  if (!base || !service || !page) {
    return Response.json({ error: "missing_configuration" }, { status: 503 });
  }
  const { mode, events } = await req.json();
  const rules = await socialDatabase(base, service).rules("facebook");
  if (mode === "preview") {
    return Response.json({
      status: "staging_ready",
      page,
      rule_count: rules.length,
      production: "NO_GO",
    });
  }
  const seen = new Set<string>();
  const matches = [];
  const input = Array.isArray(events) ? events.slice(0, 100) : [];
  for (const event of input) {
    const id = String(event?.comment_id || "");
    const author = String(event?.author_id || "");
    if (
      !id || !author || author === page || String(event?.page) !== page ||
      seen.has(id)
    ) continue;
    seen.add(id);
    const rule = matchRule(
      rules,
      String(event.post_id || ""),
      String(event.message || ""),
    );
    if (rule) matches.push({ comment_id: id, proposed_reply: rule.reply_text });
  }
  return Response.json({
    status: "simulated",
    scanned: input.length,
    matched: matches.length,
    matches,
    sent: 0,
    writes: 0,
  });
}
