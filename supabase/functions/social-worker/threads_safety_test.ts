import { handleRequest } from "./index.ts";

const scheduler = "threads-tests-only-scheduler-key-01";
const base = "https://db.example.invalid";
const activation = "2026-01-02T00:00:00Z";
const scope = {
  SOCIAL_SCHEDULER_KEY: scheduler,
  SUPABASE_SERVICE_ROLE_KEY: "test-only-service-role",
  SUPABASE_URL: base,
  THREADS_ACCESS_TOKEN: "test-only-threads-token",
  SOCIAL_SEND_ENABLED: "false",
  SOCIAL_TELEGRAM_ENABLED: "false",
};

function equal(actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`Expected ${expected}, got ${actual}`);
  }
}

async function withMock(
  mock: (url: URL, init?: RequestInit) => Response,
  run: () => Promise<void>,
) {
  const original = globalThis.fetch;
  const saved = Object.keys(scope).map((key) =>
    [key, Deno.env.get(key)] as const
  );
  globalThis.fetch = (input, init) =>
    Promise.resolve(mock(new URL(String(input)), init));
  try {
    for (const [key, value] of Object.entries(scope)) Deno.env.set(key, value);
    await run();
  } finally {
    globalThis.fetch = original;
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

function worker(task: string, mode: string) {
  return handleRequest(
    new Request("http://localhost/social-worker", {
      method: "POST",
      headers: { "x-social-scheduler-key": scheduler },
      body: JSON.stringify({ task, mode }),
    }),
  );
}

Deno.test("Threads scan preview reports bounded coverage and eligible unique matches", async () => {
  const calls: string[] = [];
  const reply = (id: string, username: string, timestamp: string) => ({
    id,
    username,
    text: "sale",
    timestamp,
  });
  await withMock((url, init) => {
    const path = url.pathname;
    calls.push(path);
    switch (path) {
      case "/rest/v1/social_reply_switch":
        equal(init?.method, "GET");
        return Response.json([{ enabled: true, activated_at: activation }]);
      case "/rest/v1/rpc/social_rules":
        equal(init?.method, "POST");
        return Response.json([{
          keyword: "sale",
          reply_text: "Thanks",
          global: true,
          post_ids: [],
        }]);
      case "/v1.0/me":
        return Response.json({ username: "owner" });
      case "/v1.0/me/threads":
        equal(init?.method, "GET");
        return Response.json({ data: [{ id: "100" }, { id: "100" }] });
      case "/v1.0/100/replies": {
        const recent = reply("200", "customer", "2026-01-03T00:00:00Z");
        return Response.json({
          data: [
            recent,
            recent,
            reply("201", "customer", "2026-01-01T00:00:00Z"),
            reply("202", "OWNER", "2026-01-03T00:00:00Z"),
          ],
          paging: {
            next: "https://graph.threads.net/v1.0/100/replies?after=2",
          },
        });
      }
      default:
        throw new Error("Unexpected request " + path);
    }
  }, async () => {
    const response = await worker("threads_scan", "scan_preview");
    equal(response.status, 200);
    const result = await response.json();
    equal(result.matched, 2);
    equal(result.eligible_matches, 1);
    equal(result.partial, true);
    equal(result.sent, 0);
    equal(calls.filter((path) => path === "/v1.0/100/replies").length, 1);

    const disabled = await worker("threads_scan", "scan");
    equal(disabled.status, 403);
    equal((await disabled.json()).sent, 0);
    equal(calls.filter((path) => path === "/v1.0/me/threads").length, 1);
  });
});

Deno.test("Threads patrol stops before scanning when account identity is absent", async () => {
  const calls: string[] = [];
  await withMock((url, init) => {
    equal(init?.redirect, "error");
    calls.push(url.pathname);
    if (url.pathname === "/rest/v1/rpc/threads_patrol_baseline") {
      return Response.json(activation);
    }
    if (url.pathname === "/v1.0/me") return Response.json({ id: "100" });
    throw new Error("Unexpected request " + url.pathname);
  }, async () => {
    for (const mode of ["scan_preview", "run_preview"]) {
      const response = await worker("threads_patrol", mode);
      equal(response.status, 502);
      const result = await response.json();
      equal(result.error, "threads_identity_missing");
      equal(result.writes, 0);
      equal(result.sent, 0);
    }
    equal(calls.length, 4);
  });
});

Deno.test("Threads patrol keeps paging credentials in the authorization header", async () => {
  await withMock((url, init) => {
    switch (url.pathname) {
      case "/rest/v1/rpc/threads_patrol_baseline":
        return Response.json(activation);
      case "/v1.0/me":
        return Response.json({ username: "owner" });
      case "/v1.0/me/threads":
        if (url.searchParams.has("after")) {
          equal(url.searchParams.has("access_token"), false);
          equal(init?.redirect, "error");
          equal(
            new Headers(init?.headers).get("authorization"),
            "Bearer " + scope.THREADS_ACCESS_TOKEN,
          );
          return Response.json({ data: [] });
        }
        return Response.json({
          data: [],
          paging: {
            next:
              "https://graph.threads.net/v1.0/me/threads?after=2&access_token=test-only",
          },
        });
      default:
        throw new Error("Unexpected request " + url.pathname);
    }
  }, async () => {
    const response = await worker("threads_patrol", "scan_preview");
    equal(response.status, 200);
    const result = await response.json();
    equal(result.post_pages, 2);
    equal(result.partial, false);
    equal(result.sent, 0);
  });
});
