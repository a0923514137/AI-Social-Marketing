import assert from "node:assert/strict";
import { handleAdmin } from "./index.ts";

Deno.test("keyword management authorizes mutations before the notification gate", async (t) => {
  const configuration = {
    R53_TELEGRAM_WEBHOOK_SECRET: "mock-webhook-secret",
    R53_TELEGRAM_ADMIN_ID: "17",
    R53_TELEGRAM_CHAT_ID: "-99",
    SUPABASE_SERVICE_ROLE_KEY: "mock-service-role",
    SUPABASE_URL: "https://database.invalid",
    TELEGRAM_BOT_TOKEN: "mock-telegram-token",
    SOCIAL_TELEGRAM_ENABLED: "false",
  };
  const previous = new Map(
    Object.keys(configuration).map((key) => [key, Deno.env.get(key)]),
  );
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];

  const draftId = "12afb820-ee77-4a17-8e8f-e6fe67cb65e9";

  function webhook(
    secret: string,
    sender = 17,
    chat = -99,
    data = "kw:off",
  ) {
    return handleAdmin(
      new Request("https://worker.invalid", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": secret },
        body: JSON.stringify({
          update_id: 21,
          callback_query: {
            id: "callback-id",
            data,
            from: { id: sender },
            message: { chat: { id: chat } },
          },
        }),
      }),
    );
  }

  try {
    for (const [key, value] of Object.entries(configuration)) {
      Deno.env.set(key, value);
    }
    globalThis.fetch = (input, init) => {
      const url = new URL(String(input));
      if (
        url.origin === configuration.SUPABASE_URL &&
        url.pathname === "/rest/v1/rpc/social_admin_event"
      ) {
        calls.push("rpc");
        assert.equal(init?.method, "POST");
        assert.deepEqual(JSON.parse(String(init.body)), {
          p_actor: "17",
          p_chat: "-99",
          p_update: 21,
          p_action: "off",
          p_value: null,
          p_reply: null,
        });
        return Promise.resolve(Response.json({ kind: "off" }));
      }
      if (url.origin === configuration.SUPABASE_URL) {
        if (url.pathname === "/rest/v1/r53_draft_reviews") {
          assert.equal(url.searchParams.get("id"), "eq." + draftId);
          if (init?.method === "GET") {
            calls.push("draft_lookup");
            return Promise.resolve(Response.json([{ status: "pending" }]));
          }
          if (init?.method === "PATCH") {
            calls.push("draft_update");
            assert.deepEqual(JSON.parse(String(init.body)), {
              status: "cancelled",
            });
            return Promise.resolve(Response.json([{ status: "cancelled" }]));
          }
        }
        if (
          url.pathname === "/rest/v1/r53_telegram_review_events" &&
          init?.method === "POST"
        ) {
          calls.push("draft_event");
          return Promise.resolve(Response.json([{}]));
        }
      }
      if (url.origin === "https://api.telegram.org") {
        calls.push(url.pathname.split("/").at(-1)!);
        return Promise.resolve(Response.json({ ok: true }));
      }
      throw Error("unexpected mock request");
    };

    await t.step(
      "reject a wrong secret, sender, or chat without side effects",
      async () => {
        assert.equal((await webhook("wrong-secret")).status, 401);
        assert.deepEqual(
          await (await webhook(configuration.R53_TELEGRAM_WEBHOOK_SECRET, 18))
            .json(),
          { ignored: true },
        );
        assert.deepEqual(
          await (await webhook(
            configuration.R53_TELEGRAM_WEBHOOK_SECRET,
            17,
            -98,
          ))
            .json(),
          { ignored: true },
        );
        assert.deepEqual(calls, []);
      },
    );

    await t.step(
      "legacy draft callbacks keep processing with notifications disabled",
      async () => {
        calls.length = 0;
        Deno.env.delete("SOCIAL_TELEGRAM_ENABLED");
        const response = await webhook(
          configuration.R53_TELEGRAM_WEBHOOK_SECRET,
          17,
          -99,
          "r53:cancel:" + draftId,
        );
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
          accepted: true,
          processed: true,
          duplicate: false,
        });
        assert.deepEqual(calls, [
          "draft_lookup",
          "draft_event",
          "draft_update",
        ]);
      },
    );

    await t.step(
      "disabled and missing settings suppress both Bot API calls",
      async () => {
        for (const setting of ["false", undefined]) {
          calls.length = 0;
          if (setting) Deno.env.set("SOCIAL_TELEGRAM_ENABLED", setting);
          else Deno.env.delete("SOCIAL_TELEGRAM_ENABLED");
          const response = await webhook(
            configuration.R53_TELEGRAM_WEBHOOK_SECRET,
          );
          assert.equal(response.status, 200);
          assert.deepEqual(await response.json(), {
            accepted: true,
            action: "off",
            notified: false,
          });
          assert.deepEqual(calls, ["rpc"]);
        }
      },
    );

    await t.step(
      "explicit enablement retains acknowledgment and notification",
      async () => {
        calls.length = 0;
        Deno.env.set("SOCIAL_TELEGRAM_ENABLED", "true");
        const response = await webhook(
          configuration.R53_TELEGRAM_WEBHOOK_SECRET,
        );
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
          accepted: true,
          action: "off",
          notified: true,
        });
        assert.deepEqual(calls, ["answerCallbackQuery", "rpc", "sendMessage"]);
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
});
