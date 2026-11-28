import {
  deliver,
  graphDelivery,
  matchRule,
  normalize,
  sendConfigured,
  socialDatabase,
} from "../shared/social.ts";

const text = (message: string, status = 200) => {
  if (status >= 400) console.log(JSON.stringify({event:"social_webhook_rejected", status, reason:message}));
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
};

function equal(a: string, b: string) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export async function handleWebhook(req: Request): Promise<Response> {
  if (req.method === "GET") {
    const verify = Deno.env.get("FB_WEBHOOK_VERIFY_TOKEN");
    const params = new URL(req.url).searchParams;
    const challenge = params.get("hub.challenge");
    return verify && params.get("hub.mode") === "subscribe" && challenge &&
        equal(params.get("hub.verify_token") || "", verify)
      ? text(challenge)
      : text("verification_failed", 403);
  }
  if (req.method !== "POST") return text("method_not_allowed", 405);
  const signature = req.headers.get("x-hub-signature-256") || "";
  if (!/^sha256=[a-f0-9]{64}$/i.test(signature)) {
    console.log(JSON.stringify({event:"social_signature_check", reason:signature ? "malformed" : "missing"}));
    return text("invalid_signature", 403);
  }
  const raw = await req.arrayBuffer();
  if (raw.byteLength > 1024 * 1024) return text("payload_too_large", 413);
  const secret = Deno.env.get("FB_APP_SECRET");
  if (!secret) return text("webhook_not_configured", 503);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const mac = Uint8Array.from(
    signature.slice(7).match(/../g)!,
    (part) => parseInt(part, 16),
  );
  if (!await crypto.subtle.verify("HMAC", key, mac, raw)) {
    console.log(JSON.stringify({event:"social_signature_check", reason:"mismatch"}));
    return text("invalid_signature", 403);
  }

  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return text("invalid_json", 400);
  }
  const platform = data?.object === "instagram"
    ? "instagram"
    : data?.object === "page"
    ? "facebook"
    : null;
  if (!platform) return text("unsupported_object", 400);
  const ig = platform === "instagram";

  const account = Deno.env.get(ig ? "IG_BUSINESS_ACCOUNT_ID" : "FB_PAGE_ID") ||
    "";
  const ownUsername = ig ? normalize(Deno.env.get("IG_USERNAME") || "") : "";
  const base = Deno.env.get("SUPABASE_URL");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!/^\d+$/.test(account) || (ig && !ownUsername) || !base || !service) {
    return text("missing_configuration", 503);
  }

  const token = Deno.env.get(
    ig ? "INSTAGRAM_ACCESS_TOKEN" : "FB_PAGE_ACCESS_TOKEN",
  );
  async function graph(path: string, form?: URLSearchParams) {
    const response = await fetch("https://graph.facebook.com/v22.0/" + path, {
      method: form ? "POST" : "GET",
      body: form,
      headers: { Authorization: "Bearer " + token },
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    return { response, data: await response.json().catch(() => null) };
  }

  const db = socialDatabase(base, service);
  const seen = new Set<string>();
  let matched = 0, sent = 0, uncertain = 0, retry = false;
  let accountEntries = 0, commentEvents = 0, eligibleEvents = 0;
  try {
    const [rules, activation] = await Promise.all([
      db.rules(platform),
      token && sendConfigured(platform) ? db.activation() : null,
    ]);
    for (const entry of Array.isArray(data.entry) ? data.entry : []) {
      if (String(entry?.id) !== account || !Array.isArray(entry?.changes)) {
        continue;
      }
      accountEntries++;
      for (const change of entry.changes) {
        const value = change?.value;
        if (
          !value ||
          (ig
            ? change.field !== "comments"
            : change.field !== "feed" || value.item !== "comment" ||
              value.verb !== "add")
        ) continue;
        commentEvents++;
        const id = String(ig ? value.id || "" : value.comment_id || "");
        const author = String(value.from?.id || "");
        const post = String(ig ? value.media?.id || "" : value.post_id || "");
        if (!author || author === account || seen.has(id)) continue;
        if (ig) {
          const username = normalize(String(value.from?.username || ""));
          if (
            !/^\d+$/.test(id) || !/^\d+$/.test(post) || !username ||
            username === ownUsername ||
            value.parent_id ||
            String(value.from?.self_ig_scoped_id || "") === author
          ) continue;
        } else if (
          !/^\d+(_\d+)?$/.test(id) || !post.startsWith(account + "_") ||
          !/^\d+_\d+$/.test(post) ||
          (value.parent_id && String(value.parent_id) !== post)
        ) continue;
        eligibleEvents++;
        seen.add(id);
        const rule = matchRule(
          rules,
          post,
          String(ig ? value.text || "" : value.message || ""),
        );
        if (!rule) continue;
        matched++;
        if (!activation || !token) continue;

        try {
          let timestamp = "";
          const time = value.created_time;
          if (
            !ig && typeof time === "number" && Number.isSafeInteger(time) &&
            time > 0 && time <= Date.now() / 1000
          ) {
            timestamp = new Date(time * 1000).toISOString();
          } else {
            const check = await graph(
              id + (ig ? "?fields=id,timestamp" : "?fields=id,created_time"),
            );
            if (!check.response.ok || String(check.data?.id) !== id) {
              if (
                check.response.status >= 500 || check.response.status === 429
              ) retry = true;
              continue;
            }
            timestamp = ig ? check.data?.timestamp : check.data?.created_time;
          }
          const outcome = await deliver(db, {
            platform,
            comment: id,
            post,
            timestamp,
            activation,
          }, async () => {
            const { response, data } = await graph(
              id + (ig ? "/replies" : "/comments"),
              new URLSearchParams({ message: rule.reply_text }),
            );
            return graphDelivery(response, data);
          });
          if (outcome === "sent") sent++;
          if (outcome === "uncertain") uncertain++;
        } catch {
          retry = true;
        }
      }
    }
  } catch {
    return text("rules_unavailable", 502);
  }
  console.log(
    JSON.stringify({
      event: "social_webhook",
      platform,
      accountEntries, commentEvents, eligibleEvents,
      matched,
      sent,
      uncertain,
    }),
  );
  return retry ? text("retry_required", 502) : text("EVENT_RECEIVED");
}

if (import.meta.main) Deno.serve(handleWebhook);
