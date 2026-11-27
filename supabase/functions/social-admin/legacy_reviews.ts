const reviewButtons = ["確認", "修改", "再次生成", "取消"];
const out = (data: unknown, status = 200, browser = false) =>
  Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      ...(browser
        ? {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "authorization,apikey,content-type",
          "access-control-allow-methods": "POST,OPTIONS",
        }
        : {}),
    },
  });

function rest(
  base: string,
  service: string,
  path: string,
  method = "GET",
  data?: unknown,
) {
  return fetch(new URL("/rest/v1/" + path, base), {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(8000),
    headers: {
      apikey: service,
      Authorization: "Bearer " + service,
      "content-type": "application/json",
      Prefer: "return=representation",
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}

function taipeiDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function draftContent(
  input: Record<string, unknown>,
  fallback?: { body: string; keyword: string; reply_text: string },
) {
  const { body, keyword, reply_text } = { ...fallback, ...input };
  if (
    typeof body !== "string" || !body.trim() || body.length > 10000 ||
    typeof keyword !== "string" || !keyword.trim() || keyword.length > 80 ||
    typeof reply_text !== "string" || !reply_text.trim() ||
    reply_text.length > 2000
  ) return null;
  return { body, keyword, reply_text };
}

export async function threadsLegacyReview(req: Request) {
  if (req.method !== "POST") return out({ error: "method_not_allowed" }, 405);
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const admin = Deno.env.get("THREADS_PATROL_ADMIN_KEY");
  if (
    !service || !(req.headers.get("authorization") === "Bearer " + service ||
      (admin && req.headers.get("x-patrol-admin-key") === admin))
  ) return out({ error: "unauthorized" }, 401);
  const base = Deno.env.get("SUPABASE_URL");
  if (!base) return out({ error: "missing_url" }, 503);
  const input = await req.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return out({ error: "invalid_json" }, 400);
  }
  const mode = input.mode ?? "preview";
  const date = input.date ?? taipeiDate();
  if (
    typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  ) {
    return out({ error: "invalid_date" }, 400);
  }
  if (
    ![
      "preview",
      "create",
      "regenerate",
      "approve",
      "edit",
      "cancel",
      "bind_post",
    ].includes(mode)
  ) {
    return out({ error: "invalid_mode" }, 400);
  }
  try {
    const response = await rest(
      base,
      service,
      "r53_draft_reviews?" +
        new URLSearchParams({
          draft_date: "eq." + date,
          select: "*",
          order: "version.desc",
          limit: "50",
        }),
    );
    if (!response.ok) {
      return out({ error: "read_failed", http: response.status }, 502);
    }
    const list = await response.json();
    if (!Array.isArray(list)) return out({ error: "read_failed" }, 502);
    const latest = list[0];
    if (mode === "preview") {
      return out({
        mode,
        latest,
        history: list,
        buttons: reviewButtons,
        telegram_sent: false,
        published: false,
      });
    }
    if (mode === "create" || mode === "regenerate") {
      if (mode === "regenerate" && !latest) {
        return out({ error: "no_previous_draft" }, 409);
      }
      if (mode === "regenerate" && latest.status === "approved") {
        return out({ error: "approved_draft_locked" }, 409);
      }
      const fields = draftContent(input);
      if (!fields) {
        return out({
          error: "draft_content_required",
          note: "Supply generated content",
        }, 400);
      }
      const saved = await rest(base, service, "r53_draft_reviews", "POST", {
        ...fields,
        draft_date: date,
        version: (latest?.version ?? 0) + 1,
        status: "pending",
      });
      const draft = saved.ok ? await saved.json() : null;
      return out({
        mode,
        created: saved.ok,
        draft,
        gpt_generated: false,
        telegram_sent: false,
        published: false,
      }, saved.ok ? 200 : saved.status === 409 ? 409 : 502);
    }
    if (!latest) return out({ error: "no_draft" }, 404);
    if (mode === "bind_post") {
      if (latest.status !== "approved") {
        return out({ error: "not_approved" }, 409);
      }
      if (
        !["threads", "instagram", "facebook"].includes(input.platform) ||
        !String(input.post_id || "").trim()
      ) {
        return out({ error: "invalid_post_binding" }, 400);
      }
      return out({
        error: "binding_requires_separate_activation",
        note: "No automatic keyword activation in R53-06",
      }, 409);
    }
    if (
      (mode === "edit" || mode === "approve") && latest.status !== "pending"
    ) {
      return out({ error: "not_pending" }, 409);
    }
    const patch = mode === "edit"
      ? draftContent(input, latest)
      : { status: mode === "approve" ? "approved" : "cancelled" };
    if (!patch) return out({ error: "empty_fields" }, 400);
    const saved = await rest(
      base,
      service,
      "r53_draft_reviews?" + new URLSearchParams({
        id: "eq." + latest.id,
        status: "eq." + latest.status,
      }),
      "PATCH",
      patch,
    );
    const draft = saved.ok ? await saved.json() : null;
    const updated = Array.isArray(draft) && draft.length === 1;
    return out(
      { mode, updated, draft, telegram_sent: false, published: false },
      !saved.ok ? 502 : updated ? 200 : 409,
    );
  } catch {
    return out({ error: "review_unavailable" }, 502);
  }
}

export async function facebookLegacyReview(req: Request) {
  const json = (data: unknown, status = 200) => out(data, status, true);
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const base = Deno.env.get("SUPABASE_URL");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const auth = req.headers.get("authorization");
  if (!base || !service || !auth || !/^Bearer \S+$/i.test(auth)) {
    return json({ error: "unauthorized" }, 401);
  }
  const response = await fetch(new URL("/auth/v1/user", base), {
    headers: { apikey: service, Authorization: auth },
    redirect: "error",
    signal: AbortSignal.timeout(6000),
  }).catch(() => null);
  if (!response?.ok) return json({ error: "unauthorized" }, 401);
  const user = await response.json().catch(() => null);
  if (
    user?.app_metadata?.facebook_review_admin !== true ||
    typeof user?.id !== "string" || !user.id
  ) {
    return json({ error: "forbidden" }, 403);
  }
  const input = await req.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return json({ error: "invalid_json" }, 400);
  }
  if (!["list", "edit", "approve", "cancel"].includes(input.action)) {
    return json({ error: "invalid_action" }, 400);
  }
  const list = input.action === "list";
  if (
    !list &&
    (typeof input.comment_id !== "string" || !input.comment_id.trim() ||
      input.comment_id.length > 200)
  ) {
    return json({ error: "invalid_comment" }, 400);
  }
  if (
    input.action === "edit" &&
    (typeof input.reply_text !== "string" || !input.reply_text.trim() ||
      input.reply_text.length > 2000)
  ) return json({ error: "invalid_reply" }, 400);
  const result = await rest(
    base,
    service,
    list ? "rpc/r71_facebook_review_list" : "rpc/r68_facebook_review",
    "POST",
    list ? {} : {
      p_comment_id: input.comment_id,
      p_action: input.action,
      p_actor: "auth:" + user.id,
      p_reply_text: input.action === "edit" ? input.reply_text : null,
    },
  ).catch(() => null);
  if (!result) return json({ error: "upstream" }, 503);
  const data = result.ok ? await result.json().catch(() => null) : null;
  return json({
    status: result.ok ? "ok" : "failed",
    data,
    send_enabled: false,
    production: "NO_GO",
  }, result.ok ? 200 : 502);
}
