import { handleAdmin } from "../social-admin/index.ts";
import { handleWebhook } from "../social-webhook/index.ts";
import { handleRequest } from "../social-worker/index.ts";
import { matchRule } from "../shared/social.ts";

const settings = {
  SOCIAL_SCHEDULER_KEY: "test-key".repeat(6),
  SUPABASE_URL: "https://database.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "test-service",
  SOCIAL_SEND_ENABLED: "true",
  SOCIAL_IG_SEND_ENABLED: "true",
  SOCIAL_FB_SEND_ENABLED: "true",
  IG_BUSINESS_ACCOUNT_ID: "100",
  IG_USERNAME: "owner",
  FB_PAGE_ID: "200",
  IG_APP_SECRET: "test-ig",
  FB_APP_SECRET: "test-fb",
  INSTAGRAM_ACCESS_TOKEN: "test-graph",
  FB_PAGE_ACCESS_TOKEN: "test-graph",
  THREADS_ACCESS_TOKEN: "test-threads",
  R53_TELEGRAM_CHAT_ID: "400",
  R53_TELEGRAM_ADMIN_ID: "300",
  R53_TELEGRAM_WEBHOOK_SECRET: "test-admin",
  TELEGRAM_BOT_TOKEN: "test-bot",
};

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw Error(JSON.stringify({ actual, expected }));
  }
}

async function withMock(request: typeof fetch, test: () => Promise<void>) {
  const saved = Object.keys(settings).map((name) =>
    [name, Deno.env.get(name)] as const
  );
  const original = globalThis.fetch;
  try {
    for (const [name, value] of Object.entries(settings)) {
      Deno.env.set(name, value);
    }
    globalThis.fetch = request;
    await test();
  } finally {
    globalThis.fetch = original;
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

Deno.test("shared matching preserves post scopes and chooses scoped then longest keyword", () => {
  const rules = [
    { keyword: "ai", reply_text: "global", global: true, post_ids: [] },
    { keyword: "ai 工具", reply_text: "longer", global: true, post_ids: [] },
    { keyword: "工具", reply_text: "scoped", global: false, post_ids: ["1"] },
  ];
  equal(matchRule(rules, "1", "ＡＩ 工具")?.reply_text, "scoped");
  equal(matchRule(rules, "2", "ＡＩ 工具")?.reply_text, "longer");
  equal(matchRule(rules, "2", "工具"), undefined);
});

Deno.test("Telegram protects commands and sends clickable menu, confirms draft, and routes five mutations", async () => {
  const actions: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];
  const nonce = "11111111-1111-1111-1111-111111111111";
  const mock: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body));
    if (path.endsWith("/social_admin_event")) {
      actions.push(body);
      const kind = ({
        menu: "menu",
        begin_add: "keyword",
        text: "confirm_add",
        confirm: "added",
        add: "added",
        edit: "edited",
        delete: "deleted",
        on: "on",
        off: "off",
      } as Record<string, string>)[body.p_action];
      return Response.json({ kind, nonce, keyword: "AI", reply: "共用" });
    }
    if (path.endsWith("/sendMessage")) messages.push(body);
    return Response.json({ ok: true });
  };
  await withMock(mock, async () => {
    let update = 0;
    const user = { id: 300 };
    const chat = { id: 400 };
    const message = (text: string) => ({ message: { from: user, chat, text } });
    const callback = (data: string) => ({
      callback_query: { id: "cb", from: user, message: { chat }, data },
    });
    const invoke = (
      body: unknown,
      secret = settings.R53_TELEGRAM_WEBHOOK_SECRET,
    ) =>
      handleAdmin(
        new Request("https://admin.invalid", {
          method: "POST",
          headers: { "x-telegram-bot-api-secret-token": secret },
          body: JSON.stringify({ update_id: ++update, ...body as object }),
        }),
      );
    equal((await invoke(message("/off"), "invalid")).status, 401);
    equal(
      await (await invoke({
        message: { from: { id: 999 }, chat, text: "/off" },
      })).json(),
      { ignored: true },
    );
    equal(
      await (await invoke({
        message: { from: user, chat: { id: 999 }, text: "/off" },
      })).json(),
      { ignored: true },
    );
    equal(actions.length, 0);
    equal((await invoke(message("選單"))).status, 200);
    const menu = messages[0].reply_markup as { inline_keyboard: unknown[][] };
    equal(menu.inline_keyboard.flat().length, 6);
    await invoke(callback("kw:begin_add"));
    await invoke(message("共用"));
    const confirm = messages.at(-1)?.reply_markup as {
      inline_keyboard: { callback_data: string }[][];
    };
    equal(confirm.inline_keyboard[0][0].callback_data, "kw:confirm:" + nonce);
    await invoke(callback("kw:confirm:" + nonce));
    for (
      const command of [
        "/add 新 | 新回覆",
        "/edit 新 | 改過",
        "/delete 新",
        "/on",
        "/off",
      ]
    ) {
      equal((await invoke(message(command))).status, 200);
    }
    equal(actions.map((v) => v.p_action), [
      "menu",
      "begin_add",
      "text",
      "confirm",
      "add",
      "edit",
      "delete",
      "on",
      "off",
    ]);
    equal(actions.at(-4)?.p_reply, "改過");
  });
});

async function signed(platform: "instagram" | "facebook") {
  const ig = platform === "instagram";
  const payload = JSON.stringify({
    object: ig ? "instagram" : "page",
    entry: [{
      id: ig ? "100" : "200",
      changes: [{
        field: ig ? "comments" : "feed",
        value: ig
          ? {
            id: "17",
            media: { id: "42" },
            from: { id: "90", username: "fan" },
            text: "ＡＩ",
          }
          : {
            item: "comment",
            verb: "add",
            comment_id: "200_18",
            post_id: "200_42",
            from: { id: "90" },
            message: "ai",
            created_time: Math.floor(Date.now() / 1000) - 1,
          },
      }],
    }],
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(
      ig ? settings.IG_APP_SECRET : settings.FB_APP_SECRET,
    ),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  const signature = Array.from(
    new Uint8Array(mac),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
  return new Request("https://webhook.invalid", {
    method: "POST",
    headers: { "x-hub-signature-256": "sha256=" + signature },
    body: payload,
  });
}

Deno.test("Worker and signed IG webhook claim once, FB/Threads share reply, and pause prevents sending", async () => {
  let enabled = true;
  let reply = "同一份文字";
  const activated_at = new Date(Date.now() - 60_000).toISOString();
  const timestamp = new Date(Date.now() - 4_000).toISOString();
  const reservations = new Set<string>();
  const requested: string[] = [];
  const posts: string[] = [];
  const mock: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "database.invalid") {
      if (url.pathname.endsWith("/social_rules")) {
        return Response.json([
          { keyword: "AI", reply_text: reply, global: true, post_ids: [] },
        ]);
      }
      if (url.pathname.endsWith("/social_reply_switch")) {
        return Response.json([{ enabled, activated_at }]);
      }
      if (url.pathname.endsWith("/social_reserve_reply")) {
        const { p_platform, p_comment } = JSON.parse(String(init?.body));
        const key = p_platform + ":" + p_comment;
        if (!enabled || reservations.has(key)) return Response.json(false);
        reservations.add(key);
        return Response.json(true);
      }
      if (url.pathname.endsWith("/r54_reply_claims")) {
        return Response.json([{}]);
      }
    }
    const path = url.pathname;
    if (init?.method === "POST") {
      const form = new URLSearchParams(String(init.body));
      requested.push(path);
      posts.push(form.get("message") || form.get("text") || "");
      return Response.json({ id: "88" });
    }
    if (path.endsWith("/media") || path.endsWith("/me/threads")) {
      return Response.json({ data: [{ id: "42" }] });
    }
    if (path.endsWith("/me")) return Response.json({ username: "owner" });
    if (path.endsWith("/17")) return Response.json({ timestamp, id: "17" });
    if (path.endsWith("/42/comments") || path.endsWith("/42/replies")) {
      return Response.json({
        data: [{ id: "17", text: "ＡＩ", username: "fan", timestamp }],
      });
    }
    throw Error("unexpected mock endpoint");
  };
  await withMock(mock, async () => {
    const worker = (task: string, mode: string, events?: unknown[]) =>
      handleRequest(
        new Request("https://worker.invalid", {
          method: "POST",
          headers: { "x-social-scheduler-key": settings.SOCIAL_SCHEDULER_KEY },
          body: JSON.stringify({ task, mode, events }),
        }),
      );
    equal(
      (await handleWebhook(
        new Request("https://webhook.invalid", { method: "POST", body: "{}" }),
      )).status,
      403,
    );
    const [igWorker, igHook] = await Promise.all([
      worker("instagram_reply", "run"),
      signed("instagram").then(handleWebhook),
    ]);
    equal(igWorker.status, 200);
    equal(igHook.status, 200);
    equal(posts, [reply]);
    equal(requested[0], "/v22.0/17/replies");
    equal((await handleWebhook(await signed("facebook"))).status, 200);
    equal((await worker("threads_scan", "scan")).status, 200);
    equal(posts, [reply, reply, reply]);
    equal(reservations.size, 3);

    reply = "更新後";
    const simulation = await worker("facebook_preview", "simulate", [
      {
        page: "200",
        comment_id: "1",
        author_id: "90",
        message: "ai",
        post_id: "200_42",
      },
    ]);
    equal((await simulation.json()).matches[0].proposed_reply, reply);
    enabled = false;
    equal((await worker("threads_scan", "scan")).status, 403);
    equal((await worker("threads_scan", "scan_preview")).status, 200);
    equal((await handleWebhook(await signed("facebook"))).status, 200);
    equal(posts.length, 3);
  });
});
