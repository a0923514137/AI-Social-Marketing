import { createYoutubePreview } from "./youtube.ts";
import { handleRequest } from "./index.ts";

const channel = "channel-owner";
const now = Date.parse("2026-11-26T12:00:00Z");
const baseline = "2026-11-26T11:55:00Z";
const rules = [
  { template_key: "default_ai", keyword: "AI", reply_text: "AI reply" },
  {
    template_key: "ep03_video_edit",
    keyword: "剪片",
    reply_text: "Editing reply",
  },
  {
    template_key: "ep08_automation",
    keyword: "自動化",
    reply_text: "Automation reply",
  },
];

function thread(id: string, text: string, {
  author = "viewer",
  publishedAt = "2026-11-26T11:56:00Z",
  replies = 0,
  canReply = true,
} = {}) {
  return {
    snippet: {
      canReply,
      totalReplyCount: replies,
      topLevelComment: {
        id,
        snippet: {
          authorChannelId: { value: author },
          publishedAt,
          textDisplay: text,
        },
      },
    },
  };
}

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function fixture(
  pages: Record<
    string,
    { items: ReturnType<typeof thread>[]; nextPageToken?: string }
  >,
  { initialStatus = 200, hasBaseline = true, identity = channel } = {},
) {
  let refreshes = 0;
  let reads = 0;
  const env: Record<string, string> = {
    YOUTUBE_CHANNEL_ID: channel,
    SUPABASE_URL: "https://mock.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "fixture",
    ...(hasBaseline ? { YOUTUBE_REPLY_BASELINE_AT: baseline } : {}),
    YOUTUBE_CLIENT_ID: "id",
    YOUTUBE_CLIENT_SECRET: "secret",
    YOUTUBE_REFRESH_TOKEN: "refresh",
  };
  const preview = createYoutubePreview({
    env: (key) => env[key],
    clock: () => now,
    request: (input, init) => {
      const json = (data: unknown, options?: ResponseInit) =>
        Promise.resolve(Response.json(data, options));
      const url = new URL(String(input));
      if (url.hostname === "oauth2.googleapis.com") {
        equal(init?.method, "POST");
        return json({
          access_token: "token-" + ++refreshes,
          expires_in: 3600,
        });
      }
      equal(init?.method ?? "GET", "GET");
      if (url.hostname === "mock.invalid") {
        equal(url.searchParams.get("platform"), "eq.instagram");
        return json(rules);
      }
      if (url.pathname.endsWith("/channels")) {
        reads++;
        if (reads === 1 && initialStatus !== 200) {
          return json({
            error: { errors: [{ reason: "quotaExceeded" }] },
          }, { status: initialStatus });
        }
        return json({ items: [{ id: identity }] });
      }
      equal(url.pathname, "/youtube/v3/commentThreads");
      equal(url.searchParams.get("allThreadsRelatedToChannelId"), channel);
      return json(pages[url.searchParams.get("pageToken") ?? ""]);
    },
  });
  return { preview, refreshes: () => refreshes, reads: () => reads };
}

Deno.test("YouTube preview shares four triggers and filters historical, self and duplicate comments across pages", async () => {
  const { preview, refreshes } = fixture({
    "": {
      items: [
        thread("ai", "ＡＩ"),
        thread("system", "系統"),
        thread("edit", "AI 剪片"),
        thread("old", "AI", { publishedAt: baseline }),
        thread("self", "AI", { author: channel }),
      ],
      nextPageToken: "p2",
    },
    p2: {
      items: [
        thread("ai", "AI"),
        thread("automation", "自動化"),
        thread("manual", "AI", { replies: 4 }),
        thread("disabled", "AI", { canReply: false }),
        thread("unmatched", "你好"),
      ],
    },
  });
  const result = await preview();
  equal(
    result.candidates.map((
      { comment_id, reply_text },
    ) => [comment_id, reply_text]),
    [
      ["ai", "AI reply"],
      ["system", "AI reply"],
      ["edit", "Editing reply"],
      ["automation", "Automation reply"],
    ],
  );
  equal(result.skipped, {
    historical: 1,
    self: 1,
    duplicate: 2,
    unmatched: 1,
    unavailable: 1,
    limit: 0,
  });
  equal(result.sends, 0);
  equal(refreshes(), 1);
});

Deno.test("YouTube preview limits candidates to 150 and rejects comments before an unset baseline", async () => {
  const page = {
    items: Array.from({ length: 100 }, (_, i) => thread("c" + i, "AI")),
    nextPageToken: "p2",
  };
  const p2 = {
    items: Array.from({ length: 60 }, (_, i) => thread("d" + i, "AI")),
  };
  const pages = { "": page, p2 };
  const result = await fixture(pages).preview();
  equal(result.candidates.length, 150);
  equal(result.skipped.limit, 10);
  const safe = await fixture(pages, { hasBaseline: false }).preview();
  equal(safe.candidates.length, 0);
  equal(safe.skipped.historical, 160);
});

Deno.test("YouTube retries one expired token and reuses the refreshed token", async () => {
  const mock = fixture({ "": { items: [] } }, { initialStatus: 401 });
  await mock.preview();
  await mock.preview();
  equal(mock.refreshes(), 2);
  equal(mock.reads(), 3);
});

Deno.test("YouTube stops reads on daily quota exhaustion and rejects an OAuth channel mismatch", async () => {
  const quota = fixture({}, { initialStatus: 403 });
  const mismatch = fixture({}, { identity: "wrong-channel" });
  equal(
    await quota.preview().catch((error) => error.message),
    "youtube_quota_exhausted",
  );
  equal(
    await quota.preview().catch((error) => error.message),
    "youtube_quota_exhausted",
  );
  equal(quota.reads(), 1);
  equal(
    await mismatch.preview().catch((error) => error.message),
    "youtube_channel_mismatch",
  );
});

Deno.test("Social worker rejects YouTube run mode before calling the adapter", async () => {
  const key = "test-only-scheduler-key-1234567890";
  Deno.env.set("SOCIAL_SCHEDULER_KEY", key);
  const response = await handleRequest(
    new Request("http://localhost/social-worker", {
      method: "POST",
      headers: { "x-social-scheduler-key": key },
      body: JSON.stringify({ task: "youtube_poll", mode: "run" }),
    }),
  );
  equal(response.status, 400);
  equal(await response.json(), { error: "invalid_mode" });
});
