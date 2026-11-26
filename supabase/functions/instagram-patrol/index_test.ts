import { handleRequest } from "./index.ts";

const testKey = "test-only-scheduler-key-1234567890";

Deno.env.set("SOCIAL_SCHEDULER_KEY", testKey);
Deno.env.set("SOCIAL_SEND_ENABLED", "false");
Deno.env.set("SOCIAL_TELEGRAM_ENABLED", "false");

function request(
  key = testKey,
  method = "POST"
): Request {
  return new Request(
    "http://localhost/instagram-patrol",
    {
      method,
      headers: {
        "x-social-scheduler-key": key
      }
    }
  );
}

async function expectStatus(
  req: Request,
  expected: number
) {
  const response = await handleRequest(req);

  if (response.status !== expected) {
    throw new Error(
      `Expected ${expected}, got ${response.status}`
    );
  }

  await response.text();
}

Deno.test("Reject non-POST request", async () => {
  await expectStatus(request(testKey, "GET"), 405);
});

Deno.test("Reject invalid scheduler key", async () => {
  await expectStatus(request("wrong-key"), 401);
});

Deno.test("Reject missing configuration", async () => {
  Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
  Deno.env.delete("SUPABASE_URL");
  Deno.env.delete("IG_BUSINESS_ACCOUNT_ID");

  await expectStatus(request(), 503);
});

Deno.test("Reject missing Instagram token", async () => {
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-only");
  Deno.env.set("SUPABASE_URL", "https://example.invalid");
  Deno.env.set("IG_BUSINESS_ACCOUNT_ID", "123456789");
  Deno.env.delete("INSTAGRAM_ACCESS_TOKEN");

  const response = await handleRequest(request());
  const data = await response.json();

  if (
    response.status !== 503 ||
    data.status !== "missing_token" ||
    data.sends !== 0 ||
    data.production !== "NO_GO"
  ) {
    throw new Error("Missing token safety check failed");
  }
});
Deno.test("Mock Instagram read-only scan", async () => {
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-only");
  Deno.env.set("SUPABASE_URL", "https://example.invalid");
  Deno.env.set("IG_BUSINESS_ACCOUNT_ID", "123456789");
  Deno.env.set("INSTAGRAM_ACCESS_TOKEN", "test-only-token");

  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls++;

    if ((init?.method || "GET") !== "GET") {
      throw new Error("Unexpected write request");
    }

    const result = (data: unknown) =>
      new Response(JSON.stringify(data), {
        headers: {
          "content-type": "application/json"
        }
      });

    if (url.startsWith(
      "https://example.invalid/rest/v1/r54_reply_templates?"
    )) {
      return result([
        { keyword: "禮盒" },
        { keyword: "禮盒" },
        { keyword: " " },
        { keyword: 123 }
      ]);
    }

    if (url ===
      "https://graph.facebook.com/v22.0/123456789/media?fields=id&limit=10"
    ) {
      return result({
        data: [
          { id: "1001" },
          { id: "invalid-id" }
        ]
      });
    }

    if (url ===
      "https://graph.facebook.com/v22.0/1001/comments?fields=id,text&limit=50"
    ) {
      return result({
        data: [
          { id: "2001", text: "請問禮盒多少錢？" },
          { id: "2001", text: "請問禮盒多少錢？" },
          { id: "2002", text: "謝謝分享" },
          { id: "invalid-id", text: "禮盒" },
          { id: "2003", text: null }
        ]
      });
    }

    throw new Error("Unexpected API request");
  };

  try {
    const response = await handleRequest(request());
    const data = await response.json();

    if (
      response.status !== 200 ||
      data.status !== "partial" ||
      data.comments_checked !== 2 ||
      data.keyword_matches !== 1 ||
      data.comment_fetch_failures !== 1 ||
      JSON.stringify(data.matched_comment_ids) !==
        JSON.stringify(["2001"]) ||
      data.sends !== 0 ||
      data.replies_enabled !== false ||
      data.production !== "NO_GO" ||
      calls !== 3
    ) {
      throw new Error(
        "Mock scan failed: " + JSON.stringify(data)
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("INSTAGRAM_ACCESS_TOKEN");
  }
});
