import { createYoutubePreview } from "./youtube.ts";
import { handleRequest } from "./index.ts";

const channel = "channel-owner";
const target = "new_comment";
const now = Date.parse("2026-11-26T12:00:00Z");
const baseline = "2026-11-26T11:55:00Z";
const rules = [
  {
    id: "default_ai",
    keyword: "AI",
    global_enabled: true,
    reply_text: "AI reply",
  },
  {
    id: "system",
    keyword: "系統",
    global_enabled: true,
    reply_text: "AI reply",
  },
  {
    id: "ep03_video_edit",
    keyword: "剪片",
    global_enabled: true,
    reply_text: "Editing reply",
  },
  {
    id: "ep08_automation",
    keyword: "自動化",
    global_enabled: true,
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
  {
    initialStatus = 200,
    hasBaseline = true,
    storedBaseline = undefined as string | undefined,
    changeDuringFinalRead = undefined as
      | "environment"
      | "channel"
      | "clock"
      | undefined,
    identity = channel,
    sendEnabled = false,
    databaseEnabled = undefined as boolean | undefined,
    insert = "success",
    failFinishOnce = false,
    existingReply = false,
    keywordRules = rules,
    expectedReply = "AI reply",
    project = "vnvrkbeyrhatbnjhglmv.supabase.co",
  } = {},
) {
  let refreshes = 0;
  let reads = 0;
  let blocked = false;
  let inserts = 0;
  let finishFailed = false;
  let remoteReply = existingReply;
  let persistedBaseline = storedBaseline;
  let currentTime = now;
  let gateReads = 0;
  let channelEnabled = databaseEnabled ?? sendEnabled;
  let setupCalls = 0;
  const claims = new Map<
    string,
    { state: string; reply_text: string; attempted_at: string }
  >();
  const env: Record<string, string> = {
    YOUTUBE_CHANNEL_ID: channel,
    SUPABASE_URL: "https://" + project,
    SOCIAL_SEND_ENABLED: String(sendEnabled),
    YOUTUBE_SEND_ENABLED: String(sendEnabled),
    YOUTUBE_SINGLE_TEST_ENABLED: String(sendEnabled),
    YOUTUBE_SINGLE_TEST_COMMENT_ID: target,
    SUPABASE_SERVICE_ROLE_KEY: "fixture",
    ...(hasBaseline ? { YOUTUBE_REPLY_BASELINE_AT: baseline } : {}),
    YOUTUBE_CLIENT_ID: "id",
    YOUTUBE_CLIENT_SECRET: "secret",
    YOUTUBE_REFRESH_TOKEN: "refresh",
  };
  const newWorker = () =>
    createYoutubePreview({
      env: (key) => env[key],
      clock: () => currentTime,
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
        if (url.hostname === project) {
          const args = typeof init?.body === "string"
            ? JSON.parse(init.body)
            : {};
          const operation = url.pathname.split("/").at(-1);
          switch (operation) {
            case "r130_youtube_settings":
              equal(init?.method ?? "GET", "GET");
              equal(url.searchParams.get("channel_id"), "eq." + channel);
              return json(
                persistedBaseline
                  ? [{
                    baseline_at: persistedBaseline,
                    send_enabled: channelEnabled,
                  }]
                  : [],
              );
            case "social_reply_switch":
              if (++gateReads === 3) {
                if (changeDuringFinalRead === "environment") {
                  env.YOUTUBE_SINGLE_TEST_ENABLED = "false";
                }
                if (changeDuringFinalRead === "channel") channelEnabled = false;
                if (changeDuringFinalRead === "clock") currentTime += 10_000;
              }
              return json([{ enabled: true, activated_at: baseline }]);
            case "r130_youtube_setup":
              setupCalls++;
              persistedBaseline ??= args.p_baseline ??
                new Date(currentTime).toISOString();
              return json({
                baseline_at: persistedBaseline,
                send_enabled: channelEnabled,
              });
            case "r130_youtube_quota":
              equal(init?.method, "PATCH");
              blocked = args.blocked;
              return Promise.resolve(new Response(null, { status: 204 }));
            case "r130_youtube_reserve":
              if (blocked) return json({ status: "quota" });
              if (args.p_comment) {
                if (claims.has(args.p_comment)) {
                  return json({ status: "duplicate" });
                }
                claims.set(args.p_comment, {
                  state: "sending",
                  reply_text: args.p_text,
                  attempted_at: new Date(now).toISOString(),
                });
              }
              return json({
                status: "reserved",
                quota_day: "2026-11-26",
                attempted_at: new Date(now).toISOString(),
              });
            case "r130_youtube_pending":
              return json(
                [...claims].filter(([, item]) =>
                  ["sending", "uncertain"].includes(item.state)
                )
                  .map(([comment_id, item]) => ({ comment_id, ...item })),
              );
            case "r130_youtube_known":
              equal(args.p_comments, [target]);
              return json([...claims.keys()]);
            case "r130_youtube_finish": {
              if (failFinishOnce && !finishFailed) {
                finishFailed = true;
                return json({}, { status: 503 });
              }
              const claim = claims.get(args.p_comment);
              if (!claim) throw new Error("Missing claim");
              claim.state = args.p_state;
              if (args.p_state === "sent") equal(args.p_response, "reply-id");
              return json(true);
            }
          }
          equal(operation, "social_keywords");
          equal(url.searchParams.get("global_enabled"), "eq.true");
          return json(keywordRules);
        }
        if (url.pathname.endsWith("/comments")) {
          if (init?.method === "POST") {
            inserts++;
            equal(url.searchParams.get("part"), "snippet");
            equal(JSON.parse(String(init.body)), {
              snippet: { parentId: target, textOriginal: expectedReply },
            });
            if (insert === "rejected") return json({}, { status: 400 });
            if (
              insert === "success" || insert === "timeout_after_commit"
            ) remoteReply = true;
            if (insert.startsWith("timeout")) {
              return Promise.reject(
                new DOMException("timeout", "TimeoutError"),
              );
            }
            return json({ id: "reply-id" });
          }
          equal(url.searchParams.get("parentId"), target);
          return json({
            items: remoteReply
              ? [{
                id: "reply-id",
                snippet: {
                  authorChannelId: { value: channel },
                  publishedAt: new Date(now).toISOString(),
                  textOriginal: expectedReply,
                },
              }]
              : [],
          });
        }
        equal(init?.method ?? "GET", "GET");
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
  return {
    preview: newWorker(),
    newWorker,
    refreshes: () => refreshes,
    reads: () => reads,
    setupCalls: () => setupCalls,
    inserts: () => inserts,
    setReply: () => {
      remoteReply = true;
    },
    setTime: (value: number) => {
      currentTime = value;
    },
    state: () => claims.get(target)?.state,
  };
}

Deno.test("YouTube preview shares four triggers and filters historical, self and duplicate comments across pages", async () => {
  const { preview, refreshes } = fixture({
    "": {
      items: [
        thread("ai", "ＡＩ"),
        thread("system", "系統"),
        thread("edit", "剪片 AI"),
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

Deno.test("Social worker disables YouTube run by default", async () => {
  const key = "test-only-scheduler-key-1234567890";
  const previousKey = Deno.env.get("SOCIAL_SCHEDULER_KEY");
  Deno.env.set("SOCIAL_SCHEDULER_KEY", key);
  try {
    const response = await handleRequest(
      new Request("http://localhost/social-worker", {
        method: "POST",
        headers: { "x-social-scheduler-key": key },
        body: JSON.stringify({ task: "youtube_poll", mode: "run" }),
      }),
    );
    equal(response.status, 403);
    equal(await response.json(), {
      error: "youtube_preview_only",
      sends: 0,
      production: "NO_GO",
    });
  } finally {
    if (previousKey === undefined) Deno.env.delete("SOCIAL_SCHEDULER_KEY");
    else Deno.env.set("SOCIAL_SCHEDULER_KEY", previousKey);
  }
});

const newComment = { "": { items: [thread(target, "AI")] } };

Deno.test("YouTube two workers post a claimed comment exactly once", async () => {
  const mock = fixture(newComment, { sendEnabled: true });
  const results = await Promise.all([
    mock.preview("run", target),
    mock.newWorker()("run", target),
  ]);
  equal(results.reduce((sum, result) => sum + result.sends, 0), 1);
  equal(mock.inserts(), 1);
  equal(mock.state(), "sent");
  await mock.newWorker()("run", target);
  equal(mock.inserts(), 1);
});

Deno.test("YouTube timeout after insert is confirmed by listing channel replies", async () => {
  const mock = fixture(newComment, {
    sendEnabled: true,
    insert: "timeout_after_commit",
  });
  const result = await mock.preview("run", target);
  equal([result.sends, result.reconciled, mock.state(), mock.inserts()], [
    0,
    1,
    "sent",
    1,
  ]);
});

Deno.test("YouTube recovers after a successful post followed by a database write failure", async () => {
  const mock = fixture(newComment, { sendEnabled: true, failFinishOnce: true });
  equal(
    await mock.preview("run", target).catch((error) => error.message),
    "youtube_database_unavailable",
  );
  equal([mock.state(), mock.inserts()], ["sending", 1]);
  equal((await mock.newWorker()("run", target)).reconciled, 1);
  equal([mock.state(), mock.inserts()], ["sent", 1]);
});

Deno.test("YouTube unresolved timeout survives restart and is reconciled without reposting", async () => {
  const mock = fixture(newComment, {
    sendEnabled: true,
    insert: "timeout_before_commit",
  });
  await mock.preview("run", target);
  equal(mock.state(), "uncertain");
  await mock.newWorker()("run", target);
  equal([mock.state(), mock.inserts()], ["uncertain", 1]);
  mock.setReply();
  equal((await mock.newWorker()("run", target)).reconciled, 1);
  equal([mock.state(), mock.inserts()], ["sent", 1]);
});

Deno.test("YouTube definitive rejection and existing replies are never reposted", async () => {
  const rejected = fixture(newComment, {
    sendEnabled: true,
    insert: "rejected",
  });
  await rejected.preview("run", target);
  await rejected.newWorker()("run", target);
  equal([rejected.state(), rejected.inserts()], ["rejected", 1]);
  const existing = fixture(newComment, {
    sendEnabled: true,
    existingReply: true,
  });
  equal((await existing.preview("run", target)).delivery, {
    existing_reply: 1,
  });
  equal(existing.inserts(), 0);
});

Deno.test("YouTube stays disabled outside Staging or with its database switch off", async () => {
  for (
    const options of [{ databaseEnabled: false }, {
      project: "other.supabase.co",
    }]
  ) {
    const mock = fixture(newComment, { sendEnabled: true, ...options });
    equal(
      await mock.preview("run", target).catch((error) => error.message),
      "youtube_send_disabled",
    );
    equal([mock.reads(), mock.inserts()], [0, 0]);
  }
});

Deno.test("YouTube preview uses a request cutoff without creating settings", async () => {
  const pages = {
    "": {
      items: [
        thread(target, "AI", {
          publishedAt: new Date(now + 1000).toISOString(),
        }),
      ],
    },
  };
  const mock = fixture(pages, { hasBaseline: false });
  equal((await mock.preview()).candidates.length, 0);
  mock.setTime(now + 2000);
  equal((await mock.newWorker()()).candidates.length, 0);
  equal(mock.setupCalls(), 0);
  const stored = fixture(pages, {
    storedBaseline: new Date(now + 1500).toISOString(),
  });
  stored.setTime(now + 2000);
  equal((await stored.preview()).candidates.length, 0);
  equal(stored.setupCalls(), 0);
});

for (
  const [change, reason] of [
    ["environment", "disabled"],
    ["channel", "disabled"],
    ["clock", "reservation_expired"],
  ] as const
) {
  Deno.test(`YouTube rejects a reserved send when ${change} changes during final gate checks`, async () => {
    const mock = fixture(newComment, {
      sendEnabled: true,
      changeDuringFinalRead: change,
    });
    const result = await mock.preview("run", target);
    equal(result.delivery, { [reason]: 1 });
    equal([result.sends, mock.state(), mock.inserts()], [0, "rejected", 0]);
  });
}

Deno.test("YouTube sends the longest enabled global keyword reply only to the configured comment", async () => {
  const mock = fixture({
    "": {
      items: [
        thread("unapproved_comment", "自動化工具"),
        thread(target, "ＡＩ 自動化工具"),
        thread("another_comment", "AI"),
      ],
    },
  }, {
    sendEnabled: true,
    expectedReply: "Automation reply",
    keywordRules: [
      {
        id: "scoped",
        keyword: "自動化工具",
        global_enabled: false,
        reply_text: "Scoped reply",
      },
      ...rules,
    ],
  });
  const result = await mock.preview("run", target);
  equal(result.checked, 3);
  equal([result.sends, mock.inserts(), mock.state()], [1, 1, "sent"]);
});
