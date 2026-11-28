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
