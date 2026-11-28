import { handleRequest } from "../social-worker/index.ts";
import { handleWebhook } from "./index.ts";

const secret = "offline-meta-app-secret";
const encoder = new TextEncoder();

async function signedRequest(raw: string, signed = raw) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(signed));
  const signature = Array.from(
    new Uint8Array(mac),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return new Request("https://webhook.example.invalid", {
    method: "POST",
    headers: { "x-hub-signature-256": "sha256=" + signature },
    body: raw,
  });
}

async function withMockedEnv(
  settings: Record<string, string>,
  run: () => Promise<void>,
) {
  const previous = Object.entries(settings).map(([name, value]) => {
    const oldValue = Deno.env.get(name);
    Deno.env.set(name, value);
    return [name, oldValue] as const;
  });
  try {
    await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

Deno.test("webhook authenticates raw body before decoding Meta events", async () => {
  await withMockedEnv({ FB_APP_SECRET: secret }, async () => {
    for (const raw of ["{", '{"object":"unsupported"}']) {
      const tampered = await handleWebhook(
        await signedRequest(raw, '{"object":"page"}'),
      );
      if (
        tampered.status !== 403 || await tampered.text() !== "invalid_signature"
      ) {
        throw Error("unauthenticated body was interpreted");
      }
    }
    const malformed = await handleWebhook(await signedRequest("{"));
    if (malformed.status !== 400 || await malformed.text() !== "invalid_json") {
      throw Error("authenticated malformed body should get invalid_json");
    }
  });
});

Deno.test("signed FB and IG comments use their rules with sending disabled", async () => {
  await withMockedEnv({
    FB_APP_SECRET: secret,
    FB_PAGE_ID: "11",
    FB_PAGE_ACCESS_TOKEN: "offline-facebook-token",
    IG_BUSINESS_ACCOUNT_ID: "22",
    IG_USERNAME: "offline-account",
    INSTAGRAM_ACCESS_TOKEN: "offline-instagram-token",
    SUPABASE_URL: "https://database.example.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "offline-service-key",
    SOCIAL_SEND_ENABLED: "false",
  }, async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    const logged: Array<Record<string, unknown>> = [];
    const originalLog = console.log;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (
        url.origin !== "https://database.example.invalid" ||
        url.pathname !== "/rest/v1/rpc/social_rules" || init?.method !== "POST"
      ) {
        calls.push("unexpected");
        throw Error("only the read-only rules RPC is allowed");
      }
      calls.push(JSON.parse(String(init.body)).p_platform);
      return Response.json([{
        keyword: "INFO",
        reply_text: "offline reply",
        global: true,
        post_ids: [],
      }]);
    };
    console.log = (line: string) => logged.push(JSON.parse(line));
    try {
      const events = [
        {
          object: "page",
          entry: [{
            id: "11",
            changes: [{
              field: "feed",
              value: {
                item: "comment",
                verb: "add",
                comment_id: "31",
                post_id: "11_41",
                from: { id: "51" },
                message: "info please",
              },
            }],
          }],
        },
        {
          object: "instagram",
          entry: [{
            id: "22",
            changes: [{
              field: "comments",
              value: {
                id: "32",
                media: { id: "42" },
                from: { id: "52", username: "visitor" },
                text: "info please",
              },
            }],
          }],
        },
      ];
      for (const event of events) {
        const response = await handleWebhook(
          await signedRequest(JSON.stringify(event)),
        );
        if (
          response.status !== 200 || await response.text() !== "EVENT_RECEIVED"
        ) {
          throw Error("signed comment was not acknowledged");
        }
      }
      if (calls.join(",") !== "facebook,instagram") {
        throw Error("unexpected platform rules calls or outbound request");
      }
      if (
        logged.length !== 2 ||
        logged.some((entry) =>
          entry.event !== "social_webhook" || entry.matched !== 1 ||
          entry.sent !== 0
        )
      ) {
        throw Error("expected a matched rule and zero sends for each platform");
      }
    } finally {
      globalThis.fetch = originalFetch;
      console.log = originalLog;
    }
  });
});

Deno.test("FB and IG single test routes publish one shared claim per target", async () => {
  const schedulerKey = "offline-meta-test-scheduler-key-32";
  const created = "2024-01-02T00:00:00.000Z";
  const activation = "2024-01-01T00:00:00.000Z";
  await withMockedEnv({
    FB_APP_SECRET: secret,
    FB_PAGE_ID: "11",
    FB_PAGE_ACCESS_TOKEN: "offline-facebook-token",
    IG_BUSINESS_ACCOUNT_ID: "22",
    IG_USERNAME: "offline-account",
    INSTAGRAM_ACCESS_TOKEN: "offline-instagram-token",
    SUPABASE_URL: "https://database.example.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "offline-service-key",
    SOCIAL_SCHEDULER_KEY: schedulerKey,
    YOUTUBE_SCHEDULER_KEY: "",
    SOCIAL_SEND_ENABLED: "true",
    SOCIAL_FB_SEND_ENABLED: "true",
    SOCIAL_IG_SEND_ENABLED: "true",
    SOCIAL_FB_SINGLE_TEST_COMMENT_ID: "31",
    SOCIAL_IG_SINGLE_TEST_COMMENT_ID: "42",
  }, async () => {
    const originalFetch = globalThis.fetch;
    const replies: string[] = [];
    const claims = new Set<string>();
    const reserveAttempts: string[] = [];
    const reads: string[] = [];
    const unexpected: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (url.origin === "https://database.example.invalid") {
        if (path === "/rest/v1/rpc/social_rules") {
          return Response.json([{
            keyword: "INFO",
            reply_text: "offline reply",
            global: true,
            post_ids: [],
          }]);
        }
        if (path === "/rest/v1/social_reply_switch") {
          return Response.json([{ enabled: true, activated_at: activation }]);
        }
        if (path === "/rest/v1/rpc/social_reserve_reply") {
          const args = JSON.parse(String(init?.body));
          const claim = args.p_platform + ":" + args.p_comment;
          reserveAttempts.push(claim);
          if (claims.has(claim)) return Response.json(false);
          claims.add(claim);
          return Response.json(true);
        }
        if (path === "/rest/v1/r54_reply_claims" && init?.method === "PATCH") {
          return Response.json([{}]);
        }
      }
      if (url.origin === "https://graph.facebook.com") {
        if (
          init?.method === "POST" && init.body instanceof URLSearchParams &&
          init.body.get("message") === "offline reply"
        ) {
          replies.push(path);
          return Response.json({ id: "offline-reply-id" });
        }
        if (init?.method === "GET") {
          reads.push(path);
          if (path === "/v22.0/22/media") {
            return Response.json({ data: [{ id: "47" }] });
          }
          if (path === "/v22.0/47/comments") {
            return Response.json({
              data: ["41", "42"].map((id) => ({
                id,
                text: "info please",
                username: "visitor",
                timestamp: created,
              })),
            });
          }
          if (path === "/v22.0/42") {
            return Response.json({ id: "42", timestamp: created });
          }
        }
      }
      unexpected.push(path);
      throw Error("unexpected request");
    };
    const instagramWorker = (mode: string, comment_id?: string) =>
      handleRequest(
        new Request("https://worker.example.invalid", {
          method: "POST",
          headers: { "x-social-scheduler-key": schedulerKey },
          body: JSON.stringify({ task: "instagram_reply", mode, comment_id }),
        }),
      );
    const webhook = async (ig: boolean) => {
      const changes = (ig ? ["41", "42"] : ["31", "32"]).map((id) =>
        ig
          ? {
            field: "comments",
            value: {
              id,
              media: { id: "47" },
              from: { id: "53", username: "visitor" },
              text: "info please",
            },
          }
          : {
            field: "feed",
            value: {
              item: "comment",
              verb: "add",
              comment_id: id,
              post_id: "11_37",
              from: { id: "53" },
              message: "info please",
              created_time: Date.parse(created) / 1000,
            },
          }
      );
      return handleWebhook(
        await signedRequest(JSON.stringify({
          object: ig ? "instagram" : "page",
          entry: [{ id: ig ? "22" : "11", changes }],
        })),
      );
    };

    try {
      for (const target of [undefined, "41"]) {
        const response = await instagramWorker("run", target);
        if (
          response.status !== 403 ||
          (await response.json()).error !== "single_test_target_required" ||
          reads.length || claims.size || replies.length || unexpected.length
        ) {
          throw Error("IG run must reject mismatched targets before reads");
        }
      }
      const preview = await instagramWorker("preview");
      const previewResult = await preview.json();
      if (
        preview.status !== 200 || previewResult.matches !== 2 ||
        previewResult.sent !== 0 || claims.size || replies.length
      ) {
        throw Error("IG preview must preserve both matches and zero claims");
      }

      const ig = await instagramWorker("run", "42");
      const igResult = await ig.json();
      if (ig.status !== 200 || igResult.sent !== 1) {
        throw Error("IG worker must publish exactly the explicit target");
      }
      for (const platform of [true, false, false]) {
        const response = await webhook(platform);
        if (
          response.status !== 200 || await response.text() !== "EVENT_RECEIVED"
        ) {
          throw Error("signed Meta batch was not acknowledged");
        }
      }
      if (
        reserveAttempts.join(",") !==
          "instagram:42,instagram:42,facebook:31,facebook:31" ||
        [...claims].join(",") !== "instagram:42,facebook:31" ||
        replies.join(",") !== "/v22.0/42/replies,/v22.0/31/comments" ||
        reads.includes("/v22.0/41") || unexpected.length
      ) {
        throw Error("Meta sent or read a non-target, or a duplicate was sent");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
