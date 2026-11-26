const api = "https://www.googleapis.com/youtube/v3/";
export const dailyLimit = 150;
export const pollIntervalMinutes = 5;
const maxPages = 5;
const templateKeys = ["ep03_video_edit", "ep08_automation", "default_ai"];

type Env = (key: string) => string | undefined;
type Template = { template_key: string; keyword: string; reply_text: string };
type Comment = {
  id?: string;
  snippet?: {
    authorChannelId?: { value?: string };
    publishedAt?: string;
    textDisplay?: string;
  };
};
type Thread = {
  snippet?: {
    topLevelComment?: Comment;
    canReply?: boolean;
    totalReplyCount?: number;
  };
};
type Page<T> = { items?: T[]; nextPageToken?: string };
type Token = { access_token?: string; expires_in?: number };

class PreviewError extends Error {}

function pacificDate(now: number) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function createYoutubePreview({
  env = (key: string) => Deno.env.get(key),
  request = fetch,
  clock = Date.now,
}: { env?: Env; request?: typeof fetch; clock?: () => number } = {}) {
  let token = "";
  let expiresAt = 0;
  let refresh: Promise<string> | undefined;
  let quotaDay = "";
  let reads = 0;
  let blocked = false;

  function required(key: string) {
    const value = env(key);
    if (!value) throw new PreviewError("missing_configuration");
    return value;
  }

  function accessToken() {
    if (token && clock() < expiresAt) return Promise.resolve(token);
    refresh ??= (async () => {
      const response = await request("https://oauth2.googleapis.com/token", {
        method: "POST",
        body: new URLSearchParams({
          client_id: required("YOUTUBE_CLIENT_ID"),
          client_secret: required("YOUTUBE_CLIENT_SECRET"),
          refresh_token: required("YOUTUBE_REFRESH_TOKEN"),
          grant_type: "refresh_token",
        }),
        signal: AbortSignal.timeout(6000),
      });
      if (!response.ok) throw new PreviewError("oauth_refresh_failed");
      const data: Token = await response.json();
      if (
        !data.access_token || !Number.isFinite(data.expires_in) ||
        data.expires_in! <= 0
      ) {
        throw new PreviewError("oauth_invalid_response");
      }
      token = data.access_token;
      expiresAt = clock() + Math.max(0, data.expires_in! - 60) * 1000;
      return token;
    })().finally(() => {
      refresh = undefined;
    });
    return refresh;
  }

  async function read<T>(
    path: string,
    params: Record<string, string>,
    retry = true,
  ): Promise<T> {
    const day = pacificDate(clock());
    if (day !== quotaDay) {
      quotaDay = day;
      reads = 0;
      blocked = false;
    }
    const access = await accessToken();
    // A warm isolate limits its own preview reads. Google enforces the project-wide quota.
    if (blocked || reads >= 2000) {
      throw new PreviewError("youtube_quota_exhausted");
    }
    reads++;
    const response = await request(
      api + path + "?" + new URLSearchParams(params),
      {
        headers: { Authorization: "Bearer " + access },
        signal: AbortSignal.timeout(6000),
      },
    );
    if (response.status === 401 && retry) {
      if (token === access) expiresAt = 0;
      return read(path, params, false);
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const reasons: string[] =
        body?.error?.errors?.map((item: { reason: string }) => item.reason) ??
          [];
      if (
        reasons.some((reason) =>
          ["quotaExceeded", "dailyLimitExceeded"].includes(reason)
        )
      ) {
        blocked = true;
        throw new PreviewError("youtube_quota_exhausted");
      }
      if (
        response.status === 429 ||
        reasons.some((reason) => /rateLimitExceeded/i.test(reason))
      ) {
        throw new PreviewError("youtube_rate_limited");
      }
      throw new PreviewError("youtube_read_failed");
    }
    return response.json();
  }

  async function templates() {
    const base = required("SUPABASE_URL");
    const service = required("SUPABASE_SERVICE_ROLE_KEY");
    const query = new URLSearchParams({
      platform: "eq.instagram",
      template_key: "in.(" + templateKeys.join(",") + ")",
      select: "template_key,keyword,reply_text",
    });
    const response = await request(
      new URL("/rest/v1/r54_reply_templates?" + query, base),
      {
        headers: { apikey: service, Authorization: "Bearer " + service },
        signal: AbortSignal.timeout(6000),
      },
    );
    if (!response.ok) throw new PreviewError("reply_templates_unavailable");
    const rows: Template[] = await response.json();
    return templateKeys.map((key) => {
      const row = rows.find((item) => item.template_key === key);
      if (!row?.keyword?.trim() || !row.reply_text?.trim()) {
        throw new PreviewError("reply_template_missing");
      }
      return row;
    });
  }

  return async function preview() {
    const channel = required("YOUTUBE_CHANNEL_ID");
    const now = clock();
    // A missing baseline makes every existing comment historical.
    const baseline = Date.parse(
      env("YOUTUBE_REPLY_BASELINE_AT") ?? new Date(now).toISOString(),
    );
    if (!Number.isFinite(baseline) || baseline > now) {
      throw new PreviewError("invalid_baseline");
    }
    const identity = await read<Page<{ id?: string }>>("channels", {
      part: "id",
      mine: "true",
    });
    if (identity.items?.length !== 1 || identity.items[0].id !== channel) {
      throw new PreviewError("youtube_channel_mismatch");
    }
    const rules = await templates();
    const normalize = (text: string) =>
      text.normalize("NFKC").trim().toLowerCase();
    const seen = new Set<string>();
    const candidates: {
      comment_id: string;
      template_key: string;
      reply_text: string;
    }[] = [];
    const skipped = {
      historical: 0,
      self: 0,
      duplicate: 0,
      unmatched: 0,
      unavailable: 0,
      limit: 0,
    };
    let checked = 0;
    let pageToken = "";
    let pages = 0;
    do {
      const page = await read<Page<Thread>>("commentThreads", {
        part: "snippet",
        allThreadsRelatedToChannelId: channel,
        order: "time",
        textFormat: "plainText",
        maxResults: "100",
        ...(pageToken ? { pageToken } : {}),
      });
      if (!Array.isArray(page.items)) {
        throw new PreviewError("youtube_invalid_response");
      }
      pages++;
      pageToken = page.nextPageToken ?? "";
      for (const thread of page.items) {
        checked++;
        const comment = thread.snippet?.topLevelComment;
        const id = comment?.id;
        const author = comment?.snippet?.authorChannelId?.value;
        const published = Date.parse(comment?.snippet?.publishedAt ?? "");
        if (!id || !author || !Number.isFinite(published) || published > now) {
          skipped.unavailable++;
          continue;
        }
        if (seen.has(id)) {
          skipped.duplicate++;
          continue;
        }
        seen.add(id);
        if (published <= baseline) {
          skipped.historical++;
          continue;
        }
        if (author === channel) {
          skipped.self++;
          continue;
        }
        const body = normalize(comment.snippet?.textDisplay ?? "");
        const rule = rules.find((item) =>
          body.includes(normalize(item.keyword)) ||
          (item.template_key === "default_ai" && body.includes("系統"))
        );
        if (!rule) {
          skipped.unmatched++;
          continue;
        }
        if (
          thread.snippet?.canReply !== true ||
          !Number.isSafeInteger(thread.snippet.totalReplyCount)
        ) {
          skipped.unavailable++;
          continue;
        }
        // Skip all threads with replies, including replies omitted by commentThreads.list.
        if (thread.snippet.totalReplyCount !== 0) {
          skipped.duplicate++;
          continue;
        }
        if (candidates.length >= dailyLimit) {
          skipped.limit++;
          continue;
        }
        candidates.push({
          comment_id: id,
          template_key: rule.template_key,
          reply_text: rule.reply_text,
        });
      }
    } while (pageToken && pages < maxPages);
    return {
      status: pageToken ? "partial" : "pass",
      checked,
      skipped,
      candidates,
      daily_reply_limit: dailyLimit,
      poll_interval_minutes: pollIntervalMinutes,
      sends: 0,
      production: "NO_GO",
    };
  };
}

const preview = createYoutubePreview();
export async function handleYoutubePreview() {
  try {
    return Response.json(await preview());
  } catch (error) {
    const code = error instanceof PreviewError
      ? error.message
      : "youtube_preview_failed";
    return Response.json({ error: code, sends: 0, production: "NO_GO" }, {
      status: /quota_exhausted|rate_limited/.test(code) ? 429 : 502,
    });
  }
}
