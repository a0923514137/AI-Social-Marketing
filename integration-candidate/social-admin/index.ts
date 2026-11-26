import { management, managementEvent } from "./management.ts";
import { handleReview } from "./review.ts";
const j = (x: unknown, s = 200) =>
  new Response(JSON.stringify(x), {
    status: s,
    headers: { "content-type": "application/json" },
  });
export async function handleAdmin(req: Request): Promise<Response> {
  if (req.method !== "POST") return j({ error: "method_not_allowed" }, 405);
  const secret = Deno.env.get("R53_TELEGRAM_WEBHOOK_SECRET") || "";
  const owner = Deno.env.get("R53_TELEGRAM_ADMIN_ID") || "";
  const chat = Deno.env.get("R53_TELEGRAM_CHAT_ID") || "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const url = Deno.env.get("SUPABASE_URL") || "";
  if (!secret || !owner || !chat || !service || !url) {
    return j({ error: "not_configured" }, 503);
  }
  if (req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return j({ error: "unauthorized" }, 401);
  }
  let u: any;
  try {
    u = await req.json();
  } catch {
    return j({ error: "invalid_json" }, 400);
  }
  const cb = u?.callback_query, msg = u?.message;
  const sender = String((cb ? cb.from?.id : msg?.from?.id) ?? "");
  const chatId = String((cb ? cb.message?.chat?.id : msg?.chat?.id) ?? "");
  if (sender !== owner || chatId !== chat) return j({ ignored: true });
  if (!Number.isSafeInteger(u?.update_id) || u.update_id < 0) {
    return j({ error: "invalid_update" }, 400);
  }
  const data = typeof cb?.data === "string" ? cb.data : "";
  const event = managementEvent(
    typeof msg?.text === "string" ? msg.text : undefined,
    cb ? data : undefined,
  );
  if (event) {
    try {
      const handled = await management(event, {
        base: url,
        service,
        actor: owner,
        chat,
        update: u.update_id,
        bot: Deno.env.get("TELEGRAM_BOT_TOKEN") || "",
        callback: typeof cb?.id === "string" ? cb.id : undefined,
      });
      if (handled) {
        return j({ accepted: true, action: event.action, notified: true });
      }
    } catch {
      return j({ error: "management_failed" }, 502);
    }
  }
  const match = /^r53:(approve|edit|regenerate|cancel):([0-9a-f-]{36})$/i.exec(
    data,
  );
  if (cb && !match) return j({ ignored: true });
  const id = match?.[2] || "";
  const endpoint = req.url;
  let draftId = id;
  if (!cb) {
    if (!msg?.text) return j({ ignored: true });
    const h = { apikey: service, Authorization: "Bearer " + service };
    const r = await fetch(
      url + "/rest/v1/r53_telegram_pending_edits?telegram_user_id=eq." + owner +
        "&select=draft_id&limit=1",
      { headers: h },
    );
    const rows = await r.json().catch(() => []);
    if (!r.ok) return j({ error: "pending_lookup_failed" }, 502);
    if (!rows?.length) return j({ ignored: true });
    draftId = rows[0].draft_id;
  }
  const r = await handleReview(
    new Request(endpoint, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + service,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        mode: cb ? "process_update" : "process_message",
        draft_id: draftId,
        update: u,
      }),
    }),
  );
  const result = await r.json().catch(() => null);
  return j({
    accepted: r.ok,
    processed: result?.updated === true || result?.ready === true ||
      result?.generated === true,
    duplicate: result?.duplicate === true,
    error: r.ok ? undefined : "handler_failed",
  }, r.ok ? 200 : 502);
}
if (import.meta.main) Deno.serve(handleAdmin);
