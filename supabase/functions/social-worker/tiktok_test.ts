import { handleRequest } from "./index.ts";
import { createTikTokPreview } from "./tiktok.ts";

const videoId = "6990565363377392901";
const credentials: Record<string, string> = {
  TIKTOK_BUSINESS_ID: "test-business",
  TIKTOK_OWNED_VIDEO_ID: videoId,
  TIKTOK_ACCESS_TOKEN: "test-only-token",
};

function assertEqual(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("TikTok only reads public comments on the configured video and reports counts", async () => {
  const top = {
    comment_id: "6990565363377392902",
    video_id: videoId,
    owner: false,
    status: "PUBLIC",
    replies: 0,
    text: "private mock text",
  };
  const cursors: (string | null)[] = [];
  const preview = createTikTokPreview({
    env: (key) => credentials[key],
    request: (input, init) => {
      const url = new URL(String(input));
      assertEqual(url.origin, "https://business-api.tiktok.com");
      assertEqual(url.pathname, "/open_api/v1.3/business/comment/list/");
      assertEqual(url.searchParams.get("business_id"), "test-business");
      assertEqual(url.searchParams.get("video_id"), videoId);
      assertEqual(url.searchParams.get("status"), "PUBLIC");
      assertEqual(url.searchParams.get("include_replies"), "false");
      assertEqual(url.searchParams.get("page_size"), "20");
      assertEqual(url.searchParams.has("Access-Token"), false);
      assertEqual(init?.method, "GET");
      assertEqual(init?.redirect, "error");
      assertEqual(
        new Headers(init?.headers).get("Access-Token"),
        "test-only-token",
      );
      const cursor = url.searchParams.get("cursor");
      cursors.push(cursor);
      return Promise.resolve(Response.json({
        code: 0,
        data: cursor === null
          ? {
            comments: [
              top,
              { ...top, comment_id: "3", owner: true },
              { ...top, comment_id: "4", status: "HIDDEN" },
              { ...top, comment_id: "5", parent_comment_id: "1" },
              { ...top, comment_id: "6", replies: 1 },
              { ...top, comment_id: "7", video_id: "111" },
            ],
            has_more: true,
            cursor: 20,
          }
          : { comments: [top], has_more: false },
      }));
    },
  });
  const response = await preview();
  assertEqual(response.status, 200);
  assertEqual(cursors, [null, "20"]);
  assertEqual(await response.json(), {
    status: "pass",
    checked: 7,
    unreplied: 1,
    sends: 0,
    production: "NO_GO",
  });
});

Deno.test("TikTok bounds paging and rejects repeated cursors", async () => {
  for (const repeated of [false, true]) {
    let calls = 0;
    const preview = createTikTokPreview({
      env: (key) => credentials[key],
      request: () => {
        calls++;
        return Promise.resolve(Response.json({
          code: 0,
          data: {
            comments: [],
            has_more: true,
            cursor: repeated ? 20 : calls * 20,
          },
        }));
      },
    });
    const response = await preview();
    const body = await response.json();
    assertEqual(response.status, repeated ? 502 : 200);
    assertEqual(calls, repeated ? 2 : 3);
    assertEqual(
      body.error ?? body.status,
      repeated ? "tiktok_invalid_pagination" : "partial",
    );
    assertEqual(body.sends, 0);
  }
});

Deno.test("TikTok redacts upstream errors and fails before reading without configuration", async () => {
  for (const status of [200, 429]) {
    const preview = createTikTokPreview({
      env: (key) => credentials[key],
      request: () =>
        Promise.resolve(
          Response.json({ code: 123, message: "sensitive mock detail" }, {
            status,
          }),
        ),
    });
    const response = await preview();
    assertEqual(response.status, status === 429 ? 429 : 502);
    assertEqual(await response.json(), {
      error: status === 429 ? "tiktok_rate_limited" : "tiktok_read_failed",
      sends: 0,
      production: "NO_GO",
    });
  }
  const unconfigured = createTikTokPreview({
    env: () => undefined,
    request: () => {
      throw new Error("unexpected network call");
    },
  });
  assertEqual((await unconfigured()).status, 503);
});

Deno.test("Social worker blocks unauthenticated TikTok requests and every run mode", async () => {
  const keyName = "SOCIAL_SCHEDULER_KEY";
  const key = "test-only-social-scheduler-key-1234567890";
  const previous = Deno.env.get(keyName);
  Deno.env.set(keyName, key);
  try {
    for (
      const [mode, token, expected] of [
        ["preview", "wrong", 401],
        ["run", key, 403],
      ] as const
    ) {
      const response = await handleRequest(
        new Request("http://localhost/social-worker", {
          method: "POST",
          headers: { "x-social-scheduler-key": token },
          body: JSON.stringify({ task: "tiktok_poll", mode }),
        }),
      );
      assertEqual(response.status, expected);
    }
  } finally {
    if (previous === undefined) Deno.env.delete(keyName);
    else Deno.env.set(keyName, previous);
  }
});
