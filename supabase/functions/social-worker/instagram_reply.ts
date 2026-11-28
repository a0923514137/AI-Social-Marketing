import {
  deliver,
  graphDelivery,
  matchRule,
  normalize,
  sendConfigured,
  sendTargetConfigured,
  socialDatabase,
} from "../shared/social.ts";

export default async function instagramReply(req: Request) {
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const base = Deno.env.get("SUPABASE_URL");
  const token = Deno.env.get("INSTAGRAM_ACCESS_TOKEN");
  const account = Deno.env.get("IG_BUSINESS_ACCOUNT_ID") || "";
  const ownUsername = normalize(Deno.env.get("IG_USERNAME") || "");
  if (req.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  if (!service || req.headers.get("authorization") !== "Bearer " + service) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!base || !token || !/^\d+$/.test(account) || !ownUsername) {
    return Response.json({ error: "missing_configuration", sent: 0 }, {
      status: 503,
    });
  }
  const { mode, comment_id: target } = await req.json();
  if (mode !== "preview" && mode !== "run") {
    return Response.json({ error: "invalid_mode" }, { status: 400 });
  }

  if (mode === "run" && !sendConfigured("instagram")) {
    return Response.json(
      { error: "send_disabled", sent: 0, production: "NO_GO" },
      { status: 403 },
    );
  }
  if (mode === "run" && !sendTargetConfigured("instagram", target)) {
    return Response.json(
      { error: "single_test_target_required", sent: 0, production: "NO_GO" },
      { status: 403 },
    );
  }
  const db = socialDatabase(base, service);
  let diagnostic: Record<string, unknown> = { stage: "initial" };
  const numeric = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : null;
  const deadline = Date.now() + 25000;
  async function graph(path: string, form?: URLSearchParams) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Error("scan_deadline");
    const response = await fetch("https://graph.facebook.com/v22.0/" + path, {
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
    const [rules, activation, media] = await Promise.all([
      db.rules("instagram").catch(() => { diagnostic = { stage: "rules_rpc", reason: "rpc_failed" }; throw Error("rules_rpc_failed"); }),
      mode === "run" ? db.activation() : null,
      graph(account + "/media?fields=id&limit=10").catch((e) => { diagnostic = { stage: "media_fetch", reason: e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "network_or_deadline" }; throw Error("media_fetch_failed"); }),
    ]);
    if (!media.response.ok || !Array.isArray(media.data?.data)) {
      diagnostic = { stage: "media_response", http_status: media.response.status, meta_code: numeric(media.data?.error?.code), meta_subcode: numeric(media.data?.error?.error_subcode), reason: media.response.ok ? "invalid_response_shape" : "meta_http_error", api_version: "v22.0", account_id_matches_expected: account === "17841402364308570" };
      throw Error("media_unavailable");
    }

    let checked = 0, matches = 0, scanFailures = 0;
    const outcomes = {
      sent: 0,
      failed: 0,
      uncertain: 0,
      skipped: 0,
      disabled: 0,
    };
    const matchedIds: string[] = [];
    for (const item of media.data.data.slice(0, 10)) {
      if (Date.now() >= deadline) {
        scanFailures++;
        break;
      }
      const post = String(item?.id || "");
      if (!/^\d+$/.test(post)) continue;
      const comments = await graph(
        post + "/comments?fields=id,text,username,timestamp&limit=50",
      ).catch(() => null);
      if (!comments?.response.ok || !Array.isArray(comments.data?.data)) {
        scanFailures++;
        continue;
      }
      for (const c of comments.data.data.slice(0, 50)) {
        if (Date.now() >= deadline) {
          scanFailures++;
          break;
        }
        checked++;
        const comment = String(c?.id || "");
        const username = normalize(String(c?.username || ""));
        if (!/^\d+$/.test(comment) || !username || username === ownUsername) {
          continue;
        }
        const rule = matchRule(rules, post, String(c.text || ""));
        if (!rule) continue;
        matches++;
        matchedIds.push(comment);
        if (mode !== "run" || comment !== target) continue;
        const result = await deliver(db, {
          platform: "instagram",
          comment,
          post,
          activation,
          timestamp: c.timestamp,
        }, async () => {
          const { response, data } = await graph(
            comment + "/replies",
            new URLSearchParams({ message: rule.reply_text }),
          );
          return graphDelivery(response, data);
        }).catch(() => "uncertain" as const);
        outcomes[result]++;
      }
    }
    return Response.json({
      status: scanFailures || outcomes.failed || outcomes.uncertain
        ? "partial"
        : "pass",
      checked,
      matches,
      sends: outcomes.sent,
      media_count: media.data.data.length,
      comments_checked: checked,
      keyword_matches: matches,
      comment_fetch_failures: scanFailures,
      matched_comment_ids: matchedIds,
      ...outcomes,
      preview_only: mode === "preview",
      production: "NO_GO",
    });
  } catch {
    return Response.json({
      error: "instagram_scan_failed",
      diagnostic,
      sent: 0,
      production: "NO_GO",
    }, { status: 502 });
  }
}
