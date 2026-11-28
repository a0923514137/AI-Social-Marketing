import {
  deliver,
  eligible,
  graphDelivery,
  matchRule,
  normalize,
  socialDatabase,
} from "../shared/social.ts";

export default async function threadsScan(req: Request) {
  const scheduler = Deno.env.get("SOCIAL_SCHEDULER_KEY") || "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const base = Deno.env.get("SUPABASE_URL");
  const token = Deno.env.get("THREADS_ACCESS_TOKEN");
  if (req.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  if (
    !service || scheduler.length < 32 ||
    req.headers.get("x-social-scheduler-key") !== scheduler
  ) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!base || !token) {
    return Response.json({ error: "missing_configuration" }, { status: 503 });
  }
  const input = await req.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return Response.json({ error: "invalid_payload" }, { status: 400 });
  }
  const { mode = "preview" } = input;
  if (!["preview", "scan_preview", "scan"].includes(mode)) {
    return Response.json({ error: "invalid_mode" }, { status: 400 });
  }

  const db = socialDatabase(base, service);
  const deadline = Date.now() + 25000;
  async function graph(path: string, form?: URLSearchParams) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Error("scan_deadline");
    const response = await fetch("https://graph.threads.net/v1.0/" + path, {
      method: form ? "POST" : "GET",
      body: form,
      headers: { Authorization: "Bearer " + token },
      redirect: "error",
      signal: AbortSignal.timeout(Math.min(8000, remaining)),
    });
    const data = await response.json().catch(() => null);
    return { response, data };
  }

  try {
    const activation = await db.activation();
    const enabled = Deno.env.get("SOCIAL_SEND_ENABLED") === "true" &&
      activation !== null;
    if (mode === "preview") {
      return Response.json({
        mode,
        configured: true,
        db_send_enabled: activation !== null,
        baseline_ready: activation !== null,
        effective_send_enabled: enabled,
        scan_supported: true,
        external_sends: 0,
        production: "NO_GO",
      });
    }
    if (mode === "scan" && !enabled) {
      return Response.json({ error: "send_disabled", sent: 0 }, {
        status: 403,
      });
    }

    const [rules, me, posts] = await Promise.all([
      db.rules("threads"),
      graph("me?fields=id,username"),
      graph("me/threads?fields=id&limit=10"),
    ]);
    const own = typeof me.data?.username === "string"
      ? normalize(me.data.username)
      : "";
    if (
      !me.response.ok || !own || !posts.response.ok ||
      !Array.isArray(posts.data?.data)
    ) throw Error("threads_read_failed");

    let scanned = 0, matched = 0, eligibleMatches = 0, scanFailures = 0;
    let truncated = posts.data.data.length > 10 ||
      Boolean(posts.data.paging?.next);
    const seenPosts = new Set<string>();
    const seenReplies = new Set<string>();
    const outcomes = {
      sent: 0,
      failed: 0,
      uncertain: 0,
      skipped: 0,
      disabled: 0,
    };
    for (const item of posts.data.data.slice(0, 10)) {
      if (Date.now() >= deadline) {
        scanFailures++;
        break;
      }
      const post = String(item?.id || "");
      if (!/^\d+$/.test(post) || seenPosts.has(post)) continue;
      seenPosts.add(post);
      const replies = await graph(
        post + "/replies?fields=id,text,username,timestamp&limit=50",
      ).catch(() => null);
      if (!replies?.response.ok || !Array.isArray(replies.data?.data)) {
        scanFailures++;
        continue;
      }
      truncated ||= replies.data.data.length > 50 ||
        Boolean(replies.data.paging?.next);
      for (const c of replies.data.data.slice(0, 50)) {
        if (Date.now() >= deadline) {
          scanFailures++;
          break;
        }
        scanned++;
        const comment = String(c?.id || "");
        if (!/^\d+$/.test(comment) || seenReplies.has(comment)) continue;
        seenReplies.add(comment);
        const username = typeof c?.username === "string"
          ? normalize(c.username)
          : "";
        if (!username || username === own) continue;
        const rule = matchRule(rules, post, String(c.text || ""));
        if (!rule) continue;
        matched++;
        if (eligible(c.timestamp, activation)) eligibleMatches++;
        if (mode !== "scan") continue;
        const result = await deliver(db, {
          platform: "threads",
          comment,
          post,
          activation,
          timestamp: c.timestamp,
        }, async () => {
          const form = new URLSearchParams({
            media_type: "TEXT",
            text: rule.reply_text,
            reply_to_id: comment,
            auto_publish_text: "true",
          });
          const { response, data } = await graph("me/threads", form);
          return graphDelivery(response, data);
        }).catch(() => "uncertain" as const);
        outcomes[result]++;
      }
    }
    return Response.json({
      mode,
      scanned,
      matched,
      eligible_matches: eligibleMatches,
      scanFailures,
      partial: truncated || scanFailures > 0,
      ...outcomes,
      production: "NO_GO",
    });
  } catch {
    return Response.json(
      { error: "threads_scan_failed", production: "NO_GO" },
      { status: 502 },
    );
  }
}
