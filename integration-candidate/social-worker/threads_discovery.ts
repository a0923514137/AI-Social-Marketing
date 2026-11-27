import { normalize, socialDatabase } from "../shared/social.ts";

const graph = new URL("https://graph.threads.net/v1.0/");
const out = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });

function authorize(req: Request, name: string, allowScheduler = false) {
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const admin = Deno.env.get(name);
  const scheduler = Deno.env.get("SOCIAL_SCHEDULER_KEY") || "";
  return (service &&
    req.headers.get("authorization") === "Bearer " + service) ||
    (admin && req.headers.get("x-patrol-admin-key") === admin) ||
    (allowScheduler && scheduler.length >= 32 &&
      req.headers.get("x-social-scheduler-key") === scheduler);
}

function permalink(value: string) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" || url.port || url.username || url.password ||
      !["threads.com", "www.threads.com", "threads.net", "www.threads.net"]
        .includes(url.hostname)
    ) return null;
    const match = /^\/@([a-z0-9._]+)\/post\/([a-z0-9_-]+)\/?$/i.exec(
      url.pathname,
    );
    return match
      ? { owner: match[1].toLowerCase(), shortcode: match[2] }
      : null;
  } catch {
    return null;
  }
}

async function threadsGet(url: URL, token: string, timeout = 5000) {
  url.searchParams.delete("access_token");
  const response = await fetch(url, {
    headers: { Authorization: "Bearer " + token },
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
  });
  return {
    http: response.status,
    ok: response.ok,
    body: await response.json().catch(() => null),
  };
}

export async function resolvePost(req: Request) {
  if (req.method !== "GET") return out({ error: "method_not_allowed" }, 405);
  if (!authorize(req, "THREADS_PATROL_ADMIN_KEY", true)) {
    return out({ error: "unauthorized" }, 401);
  }
  const token = Deno.env.get("THREADS_ACCESS_TOKEN");
  if (!token) {
    return out({ status: "unavailable", reason: "token_missing" }, 503);
  }
  const value = new URL(req.url).searchParams.get("url") ??
    Deno.env.get("THREADS_RESOLVE_DEFAULT_URL") ??
    "https://www.threads.com/@sandwichdadhelp/post/Df7PtYoEYcp";
  const target = permalink(value);
  if (!target) return out({ error: "invalid_post_url" }, 400);
  const { shortcode } = target;
  let next: URL | null = new URL(
    "me/threads?fields=id,permalink&limit=100",
    graph,
  );
  let pages = 0;
  try {
    while (next && pages < 5) {
      if (
        next.origin !== graph.origin ||
        !/^\/v1\.0\/(?:me|\d+)\/threads$/.test(next.pathname) ||
        next.username || next.password
      ) {
        return out(
          { status: "unavailable", reason: "invalid_paging_url" },
          502,
        );
      }
      const result = await threadsGet(next, token, 6500);
      pages++;
      if (!result.ok) {
        return out({
          status: "unavailable",
          reason: "threads_api_" + result.http,
        }, 502);
      }
      if (!Array.isArray(result.body?.data)) {
        return out(
          { status: "unavailable", reason: "invalid_api_response" },
          502,
        );
      }
      for (const row of result.body.data) {
        const link = typeof row?.permalink === "string"
          ? permalink(row.permalink)
          : null;
        if (
          link?.owner === target.owner && link.shortcode === shortcode &&
          /^\d+$/.test(String(row.id))
        ) {
          return out({
            status: "resolved",
            shortcode,
            post_id: String(row.id),
            pages_scanned: pages,
          });
        }
      }
      const link = result.body.paging?.next;
      next = typeof link === "string" && link ? new URL(link) : null;
    }
    return out({
      status: "not_found",
      shortcode,
      pages_scanned: pages,
      ...(next ? { partial: true } : {}),
    });
  } catch {
    return out({ status: "unavailable", reason: "api_timeout" }, 502);
  }
}

export async function keywordSearch(req: Request) {
  if (req.method !== "POST") return out({ error: "method" }, 405);
  if (!authorize(req, "THREADS_PATROL_V2_ADMIN_KEY")) {
    return out({ error: "unauthorized" }, 401);
  }
  const token = Deno.env.get("THREADS_PATROL_V2_ACCESS_TOKEN");
  if (!token) return out({ error: "missing_token" }, 503);
  const input = await req.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return out({ error: "invalid_json" }, 400);
  }
  const mode = input.mode ?? "search_only";
  if (
    !["search_only", "preview", "collect", "run_preview", "diagnostic"]
      .includes(mode)
  ) {
    return out({ error: "invalid_mode" }, 400);
  }
  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const db = base && key ? socialDatabase(base, key) : null;
  const collect = mode === "collect" || mode === "run_preview";
  const diagnostic = mode === "diagnostic";
  if (collect && !db) return out({ error: "missing_ai_or_db_config" }, 503);
  let words: string[] = [];
  if (input.keywords !== undefined) {
    if (
      !Array.isArray(input.keywords) || input.keywords.length > 12 ||
      input.keywords.some((word: unknown) =>
        typeof word !== "string" || !normalize(word) || word.length > 100
      )
    ) {
      return out({ error: "invalid_keywords" }, 400);
    }
    words = input.keywords;
  } else {
    try {
      if (!db) return out({ error: "rules_unavailable" }, 503);
      words = (await db.rules("threads")).filter((rule) => rule.global).map((
        rule,
      ) => rule.keyword);
    } catch {
      return out({ error: "rules_unavailable" }, 502);
    }
  }
  const keywords = [
    ...new Map(words.map((word) => [normalize(word), word.trim()])).values(),
  ];
  if (keywords.length > 12) {
    return out({ error: "keyword_limit", maximum: 12 }, 400);
  }

  let ownName = "";
  if (diagnostic) {
    try {
      const me = await threadsGet(
        new URL("me?fields=id,username", graph),
        token,
        7000,
      );
      if (!me.ok || typeof me.body?.username !== "string") {
        return out({ error: "identity_failed", http: me.http }, 502);
      }
      ownName = normalize(me.body.username);
    } catch {
      return out({ error: "identity_failed" }, 502);
    }
  }
  const now = Date.now();
  const results = [];
  const exclusions = { older: 0, future: 0, invalid: 0, duplicate: 0 };
  const candidates = new Map<string, object>();
  const searches = await Promise.all(keywords.map(async (keyword) => {
    const url = new URL("keyword_search", graph);
    url.search = new URLSearchParams({
      q: keyword,
      search_type: "RECENT",
      limit: "50",
      fields: diagnostic
        ? "id,username,timestamp"
        : "id,text,timestamp,permalink",
    }).toString();
    return await threadsGet(url, token).catch(() => null);
  }));
  for (const [index, keyword] of keywords.entries()) {
    const search = searches[index];
    if (!search) {
      results.push({ keyword, error: "network_or_timeout" });
      continue;
    }
    const rows: Array<
      {
        id?: unknown;
        text?: unknown;
        permalink?: unknown;
        timestamp?: string;
        username?: unknown;
      } | null
    > = Array.isArray(search.body?.data) ? search.body.data.slice(0, 50) : [];
    const result = {
      keyword,
      http: search.http,
      count: rows.length,
      error_code: search.body?.error?.code ?? null,
    };
    if (diagnostic) {
      const own = rows.filter((row) =>
        typeof row?.username === "string" && normalize(row.username) === ownName
      ).length;
      const unknown = rows.filter((row) =>
        !row?.username
      ).length;
      results.push({
        ...result,
        own,
        other: rows.length - own - unknown,
        unknown,
      });
      continue;
    }
    results.push(result);
    if (!collect || !search.ok) continue;
    for (const row of rows) {
      const posted = Date.parse(row?.timestamp ?? "");
      if (
        !row || !Number.isFinite(posted) || typeof row.id !== "string" ||
        !/^\d+$/.test(row.id) ||
        typeof row.text !== "string" || typeof row.permalink !== "string" ||
        !permalink(row.permalink)
      ) {
        exclusions.invalid++;
        continue;
      }
      if (posted > now) {
        exclusions.future++;
        continue;
      }
      if (posted < now - 20 * 60000) {
        exclusions.older++;
        continue;
      }
      if (candidates.has(row.id)) {
        exclusions.duplicate++;
        continue;
      }
      candidates.set(row.id, {
        post_id: row.id,
        keyword,
        post_text: row.text.slice(0, 10000),
        permalink: row.permalink,
        posted_at: new Date(posted).toISOString(),
        status: "pending",
      });
    }
  }

  if (diagnostic) {
    return out({ mode, results, writes: 0, published: 0, notifications: 0 });
  }
  let writes = 0, duplicates = 0, failed = 0;
  if (collect && candidates.size) {
    try {
      const response = await fetch(
        new URL(
          "/rest/v1/threads_patrol_v2_candidates?on_conflict=post_id",
          base,
        ),
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10000),
          headers: {
            apikey: key!,
            Authorization: "Bearer " + key,
            "content-type": "application/json",
            Prefer: "resolution=ignore-duplicates,return=representation",
          },
          body: JSON.stringify([...candidates.values()]),
        },
      );
      if (!response.ok) throw Error("candidate_write_failed");
      const rows = await response.json();
      if (!Array.isArray(rows) || rows.length > candidates.size) {
        throw Error("invalid_write_result");
      }
      writes = rows.length;
      duplicates = candidates.size - writes;
    } catch {
      failed = candidates.size;
    }
  }
  return out({
    mode: collect ? "collect" : "search_only",
    results,
    eligible: candidates.size,
    exclusions,
    writes,
    duplicates,
    failed,
    ai_calls: 0,
    published: 0,
    production: "NO_GO",
  }, failed ? 502 : 200);
}
