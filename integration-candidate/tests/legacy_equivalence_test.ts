import { handleAdmin } from "../social-admin/index.ts";
import { handleRequest } from "../social-worker/index.ts";

const environment = {
  SUPABASE_URL: "https://db.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "service-test",
  THREADS_ACCESS_TOKEN: "resolver-test",
  THREADS_PATROL_ADMIN_KEY: "admin-test",
  THREADS_PATROL_V2_ACCESS_TOKEN: "search-test",
  THREADS_PATROL_V2_ADMIN_KEY: "search-admin",
};
const worker = "https://edge.invalid/social-worker?task=";
const admin = "https://edge.invalid/social-admin?task=";
const serviceHeaders = { authorization: "Bearer service-test" };

async function mock(fetcher: typeof fetch, run: () => Promise<void>) {
  const previous = globalThis.fetch;
  const saved = Object.entries(environment).map(([name, value]) => {
    const current = Deno.env.get(name);
    Deno.env.set(name, value);
    return { name, current };
  });
  try {
    globalThis.fetch = fetcher;
    await run();
  } finally {
    globalThis.fetch = previous;
    for (const { name, current } of saved) {
      if (current === undefined) Deno.env.delete(name);
      else Deno.env.set(name, current);
    }
  }
}
function eq(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw Error(JSON.stringify({ actual, expected }));
  }
}
const call = (url: string, body: unknown, headers = serviceHeaders) =>
  new Request(url, { method: "POST", headers, body: JSON.stringify(body) });

Deno.test("standalone resolver authenticates, paginates within Threads, and rejects hostile URLs", async () => {
  let hits = 0;
  await mock((request, init) => {
    const url = new URL(String(request));
    eq(url.hostname, "graph.threads.net");
    eq(url.searchParams.has("access_token"), false);
    eq(new Headers(init?.headers).get("authorization"), "Bearer resolver-test");
    hits++;
    return Promise.resolve(
      Response.json(
        url.searchParams.has("after")
          ? {
            data: [{
              id: "72",
              permalink: "https://www.threads.net/@owner/post/X_8?foo=bar",
            }],
          }
          : {
            data: [],
            paging: {
              next: hits === 1
                ? "https://graph.threads.net/v1.0/42/threads?after=next&access_token=discard"
                : "https://bad.invalid/threads",
            },
          },
      ),
    );
  }, async () => {
    const route = worker + "threads_resolve_post&url=";
    const valid = route +
      encodeURIComponent("https://www.threads.com/@Owner/post/X_8/");
    eq((await handleRequest(new Request(valid))).status, 401);
    eq(
      (await handleRequest(
        new Request(
          route +
            encodeURIComponent(
              "https://threads.com.bad.invalid/@owner/post/X_8",
            ),
          { headers: serviceHeaders },
        ),
      )).status,
      400,
    );
    eq(hits, 0);
    eq(
      await (await handleRequest(
        new Request(valid, { headers: serviceHeaders }),
      )).json(),
      { status: "resolved", shortcode: "X_8", post_id: "72", pages_scanned: 2 },
    );
    eq(
      (await handleRequest(new Request(valid, { headers: serviceHeaders })))
        .status,
      502,
    );
    eq(hits, 3);
  });
});

Deno.test("Threads search diagnostics and collection retain time filtering and database deduplication", async () => {
  const saved = new Set<string>();
  let writeRequests = 0;
  const fresh = new Date(Date.now() - 3000).toISOString();
  await mock((request, init) => {
    const url = new URL(String(request));
    if (url.pathname.endsWith("/social_rules")) {
      return Promise.resolve(Response.json([
        { keyword: "AI", global: true },
        { keyword: "工具", global: true },
        { keyword: "只限貼文", global: false },
      ]));
    }
    if (url.pathname.endsWith("/me")) {
      return Promise.resolve(Response.json({ username: "owner" }));
    }
    if (url.pathname.endsWith("/keyword_search")) {
      if (url.searchParams.get("fields")?.includes("username")) {
        return Promise.resolve(
          Response.json({
            data: [{ username: "OWNER" }, {}, { username: "visitor" }],
          }),
        );
      }
      if (!["AI", "工具"].includes(url.searchParams.get("q") || "")) {
        throw Error("unexpected search term");
      }
      const item = {
        id: "32",
        text: "AI 工具",
        timestamp: fresh,
        permalink: "https://www.threads.com/@user/post/A",
      };
      return Promise.resolve(
        Response.json({
          data: [item, {
            ...item,
            id: "33",
            timestamp: "2020-01-01T00:00:00Z",
          }],
        }),
      );
    }
    if (url.pathname.endsWith("/threads_patrol_v2_candidates")) {
      eq(url.searchParams.get("on_conflict"), "post_id");
      eq(
        new Headers(init?.headers).get("prefer"),
        "resolution=ignore-duplicates,return=representation",
      );
      writeRequests++;
      const rows = JSON.parse(String(init?.body));
      eq(rows.length, 1);
      eq(rows[0].post_id, "32");
      if (saved.has("32")) return Promise.resolve(Response.json([]));
      saved.add("32");
      return Promise.resolve(Response.json(rows));
    }
    throw Error("unexpected network");
  }, async () => {
    const route = worker + "threads_keyword_search";
    eq(
      (await handleRequest(
        call(route, {}, { authorization: "Bearer invalid" }),
      )).status,
      401,
    );
    const diagnostic = await (await handleRequest(
      call(route, { mode: "diagnostic", keywords: ["AI"] }),
    )).json();
    eq(diagnostic.results[0].own, 1);
    eq(diagnostic.results[0].other, 1);
    eq(diagnostic.results[0].unknown, 1);
    eq(
      (await (await handleRequest(call(route, { mode: "preview" }))).json())
        .writes,
      0,
    );
    eq(writeRequests, 0);
    const first = await (await handleRequest(call(route, { mode: "collect" })))
      .json();
    eq([first.eligible, first.writes, first.published], [1, 1, 0]);
    eq([first.exclusions.older, first.exclusions.duplicate], [2, 1]);
    const repeated =
      await (await handleRequest(call(route, { mode: "run_preview" }))).json();
    eq([repeated.writes, repeated.duplicates], [0, 1]);
  });
});

Deno.test("old Threads review lists dates, versions and edits drafts without publishing or binding", async () => {
  const drafts: Record<string, unknown>[] = [];
  await mock((request, init) => {
    const url = new URL(String(request));
    eq(url.hostname, "db.invalid");
    eq(url.pathname, "/rest/v1/r53_draft_reviews");
    if (init?.method === "POST") {
      const row = {
        ...JSON.parse(String(init.body)),
        id: String(drafts.length + 1),
      };
      drafts.unshift(row);
      return Promise.resolve(Response.json([row]));
    }
    if (init?.method === "PATCH") {
      eq(url.searchParams.get("status"), "eq." + drafts[0].status);
      Object.assign(drafts[0], JSON.parse(String(init.body)));
      return Promise.resolve(Response.json([drafts[0]]));
    }
    eq(url.searchParams.get("draft_date"), "eq.2026-11-27");
    return Promise.resolve(Response.json(drafts));
  }, async () => {
    const route = admin + "threads_review";
    const invoke = (mode: string, fields = {}) =>
      handleAdmin(call(route, { mode, date: "2026-11-27", ...fields }));
    eq(
      (await handleAdmin(call(route, {}, { authorization: "Bearer bad" })))
        .status,
      401,
    );
    const content = { body: "草稿", keyword: "AI", reply_text: "回覆" };
    eq((await invoke("create", content)).status, 200);
    eq((await invoke("regenerate", content)).status, 200);
    const preview = await (await invoke("preview")).json();
    eq(preview.latest.version, 2);
    eq(preview.history.length, 2);
    eq((await invoke("edit", { body: "改稿" })).status, 200);
    eq((await (await invoke("approve")).json()).published, false);
    eq((await invoke("regenerate", content)).status, 409);
    eq(
      (await (await invoke("bind_post", { platform: "threads", post_id: "42" }))
        .json()).error,
      "binding_requires_separate_activation",
    );
    eq((await invoke("cancel")).status, 200);
  });
});

Deno.test("old Facebook review requires verified app metadata and supports all four review actions", async () => {
  let authorized = false;
  const routed: string[] = [];
  await mock((request, init) => {
    const url = new URL(String(request));
    eq(url.hostname, "db.invalid");
    if (url.pathname === "/auth/v1/user") {
      eq(new Headers(init?.headers).get("authorization"), "Bearer user-token");
      return Promise.resolve(
        Response.json({
          id: "uid",
          app_metadata: { facebook_review_admin: authorized },
          user_metadata: { facebook_review_admin: true },
        }),
      );
    }
    if (url.pathname.endsWith("r71_facebook_review_list")) {
      routed.push("list");
      return Promise.resolve(Response.json([]));
    }
    eq(url.pathname, "/rest/v1/rpc/r68_facebook_review");
    const args = JSON.parse(String(init?.body));
    eq(args.p_actor, "auth:uid");
    eq(args.p_reply_text, args.p_action === "edit" ? "修改" : null);
    routed.push(args.p_action);
    return Promise.resolve(Response.json(args.p_action));
  }, async () => {
    const route = admin + "facebook_review";
    const invoke = (action: string) =>
      handleAdmin(
        call(route, { action, comment_id: "1", reply_text: "修改" }, {
          authorization: "Bearer user-token",
        }),
      );
    eq(
      (await handleAdmin(new Request(route, { method: "OPTIONS" }))).headers
        .get("access-control-allow-origin"),
      "*",
    );
    eq((await invoke("list")).status, 403);
    eq(routed.length, 0);
    authorized = true;
    for (const action of ["list", "edit", "approve", "cancel"]) {
      const result = await invoke(action);
      eq(result.status, 200);
      eq((await result.json()).send_enabled, false);
    }
    eq(routed, ["list", "edit", "approve", "cancel"]);
  });
});
