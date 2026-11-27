import { matchGlobalKeyword, type GlobalKeyword } from "../shared/global_keyword_candidate.ts";
const api = "https://www.googleapis.com/youtube/v3/";
export const dailyLimit = 150;
export const pollIntervalMinutes = 5;
const maxPages = 5;
const stagingOrigin = "https://vnvrkbeyrhatbnjhglmv.supabase.co";

type Env = (key: string) => string | undefined;
type Comment = {
  id?: string;
  snippet?: {
    authorChannelId?: { value?: string };
    publishedAt?: string;
    textDisplay?: string;
    textOriginal?: string;
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

type Reservation = {
  status: string;
  quota_day?: string;
  attempted_at?: string;
};
type Claim = { comment_id: string; reply_text: string; attempted_at: string };

export function createYoutubePreview({
  env = (key: string) => Deno.env.get(key),
  request = fetch,
  clock = Date.now,
}: { env?: Env; request?: typeof fetch; clock?: () => number } = {}) {
  let token = "";
  let expiresAt = 0;
  let refresh: Promise<string> | undefined;

  function required(key: string) {
    const value = env(key);
    if (!value) throw new PreviewError("missing_configuration");
    return value;
  }

  async function database<T>(path: string, init: RequestInit = {}): Promise<T> {
    const service = required("SUPABASE_SERVICE_ROLE_KEY");
    const response = await request(
      new URL("/rest/v1/" + path, required("SUPABASE_URL")),
      {
        ...init,
        headers: {
          apikey: service,
          Authorization: "Bearer " + service,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(6000),
      },
    );
    if (!response.ok) throw new PreviewError("youtube_database_unavailable");
    return response.status === 204 ? undefined as T : response.json();
  }

  function rpc<T>(operation: string, args: Record<string, unknown>) {
    return database<T>("rpc/r130_youtube_" + operation, {
      method: "POST",
      body: JSON.stringify(args),
    });
  }

  function quotaExceeded(
    body: { error?: { errors?: { reason?: string }[] } } | null,
  ) {
    return body?.error?.errors?.some(({ reason }) =>
      reason === "quotaExceeded" || reason === "dailyLimitExceeded"
    );
  }

  function blockQuota(day: string) {
    return database(
      "r130_youtube_quota?" + new URLSearchParams({ quota_day: "eq." + day }),
      {
        method: "PATCH",
        body: JSON.stringify({ blocked: true }),
      },
    );
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
    const access = await accessToken();
    const reservation = await rpc<Reservation>("reserve", {
      p_channel: required("YOUTUBE_CHANNEL_ID"),
    });
    if (reservation.status !== "reserved" || !reservation.quota_day) {
      throw new PreviewError("youtube_quota_exhausted");
    }
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
      if (quotaExceeded(body)) {
        await blockQuota(reservation.quota_day);
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

  async function globalActivation(): Promise<number> {
    const rows = await database<{ enabled: boolean; activated_at: string | null }[]>(
      "social_reply_switch?singleton=eq.true&select=enabled,activated_at",
    );
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : undefined;
    const activated = Date.parse(row?.activated_at ?? "");
    if (row?.enabled !== true || !Number.isFinite(activated) || activated > clock()) {
      throw new PreviewError("youtube_send_disabled");
    }
    return activated;
  }

  async function templates(): Promise<GlobalKeyword[]> {
    const query = new URLSearchParams({
      global_enabled: "eq.true",
      select: "id,keyword,reply_text,global_enabled",
      order: "keyword_key.asc",
    });
    const rows = await database<GlobalKeyword[]>("social_keywords?" + query);
    if (!Array.isArray(rows)) throw new PreviewError("reply_templates_unavailable");
    return rows;
  }

  function finish(
    channel: string,
    comment: string,
    state: string,
    response?: string,
  ) {
    return rpc<boolean>("finish", {
      p_channel: channel,
      p_comment: comment,
      p_state: state,
      p_response: response ?? null,
    });
  }

  async function replies(
    parentId: string,
    match: (comment: Comment) => boolean,
  ) {
    let pageToken = "";
    for (let page = 0; page < 5; page++) {
      const result = await read<Page<Comment>>("comments", {
        part: "snippet",
        parentId,
        maxResults: "100",
        textFormat: "plainText",
        ...(pageToken ? { pageToken } : {}),
      });
      if (!Array.isArray(result.items)) {
        throw new PreviewError("youtube_invalid_response");
      }
      const found = result.items.find(match);
      if (found) return found;
      pageToken = result.nextPageToken ?? "";
      if (!pageToken) return undefined;
    }
    throw new PreviewError("youtube_reply_check_partial");
  }

  async function reconcile(channel: string, claim: Claim) {
    const match = await replies(
      claim.comment_id,
      (comment) =>
        !!comment.id && comment.snippet?.authorChannelId?.value === channel &&
        comment.snippet.textOriginal === claim.reply_text &&
        Date.parse(comment.snippet.publishedAt ?? "") >=
          Date.parse(claim.attempted_at) - 5000,
    );
    if (!match?.id) {
      await finish(channel, claim.comment_id, "uncertain");
      return false;
    }
    return finish(channel, claim.comment_id, "sent", match.id);
  }

  async function deliver(
    channel: string,
    candidate: {
      comment_id: string;
      reply_text: string;
      author: string;
      published_at: string;
    },
  ) {
    if (Date.parse(candidate.published_at) <= await globalActivation()) return "disabled";
    if (await replies(candidate.comment_id, () => true)) {
      return "existing_reply";
    }
    const access = await accessToken();
    const claim = await rpc<Reservation>("reserve", {
      p_channel: channel,
      p_comment: candidate.comment_id,
      p_author: candidate.author,
      p_published: candidate.published_at,
      p_text: candidate.reply_text,
    });
    if (claim.status !== "reserved") return claim.status;
    if (!claim.quota_day || !claim.attempted_at) {
      throw new PreviewError("youtube_invalid_reservation");
    }
    // Keep the POST within the database reservation's Pacific day.
    if (!(Math.abs(clock() - Date.parse(claim.attempted_at)) < 10000)) {
      await finish(channel, candidate.comment_id, "rejected");
      return "reservation_expired";
    }

    try {
      if (Date.parse(candidate.published_at) <= await globalActivation()) {
        await finish(channel, candidate.comment_id, "rejected");
        return "disabled";
      }
    } catch (error) {
      await finish(channel, candidate.comment_id, "rejected");
      throw error;
    }
    let response: Response | undefined;
    try {
      response = await request(api + "comments?part=snippet", {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: "Bearer " + access,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          snippet: {
            parentId: candidate.comment_id,
            textOriginal: candidate.reply_text,
          },
        }),
        signal: AbortSignal.timeout(6000),
      });
    } catch {
      // The server may have accepted the request before the connection failed.
    }
    const body = await response?.json().catch(() => null);
    if (response?.ok && typeof body?.id === "string" && body.id) {
      await finish(channel, candidate.comment_id, "sent", body.id);
      return "sent";
    }
    if (response && [400, 401, 403, 404, 429].includes(response.status)) {
      const blocked = quotaExceeded(body);
      if (blocked) await blockQuota(claim.quota_day);
      if (response.status === 401 && token === access) expiresAt = 0;
      await finish(channel, candidate.comment_id, "rejected");
      return blocked ? "quota" : "rejected";
    }
    await finish(channel, candidate.comment_id, "uncertain");
    const confirmed = await reconcile(channel, {
      ...candidate,
      attempted_at: claim.attempted_at,
    });
    return confirmed ? "reconciled" : "uncertain";
  }

  return async function poll(mode: "preview" | "run" = "preview", target?: string) {
    if (
      mode === "run" && (env("SOCIAL_SEND_ENABLED") !== "true" ||
        env("YOUTUBE_SEND_ENABLED") !== "true" ||
        new URL(required("SUPABASE_URL")).origin !== stagingOrigin)
    ) {
      throw new PreviewError("youtube_send_disabled");
    }
    if (mode === "run" && (!target || !/^[A-Za-z0-9_-]{8,128}$/.test(target))) throw new PreviewError("youtube_send_disabled");
    const channel = required("YOUTUBE_CHANNEL_ID");
    const settings = await rpc<{ baseline_at: string; send_enabled: boolean }>(
      "setup",
      {
        p_channel: channel,
        p_baseline: env("YOUTUBE_REPLY_BASELINE_AT") ?? null,
      },
    );
    if (mode === "run" && !settings.send_enabled) {
      throw new PreviewError("youtube_send_disabled");
    }
    const baseline = Math.max(Date.parse(settings.baseline_at),
      mode === "run" ? await globalActivation() : -Infinity);
    if (!Number.isFinite(baseline)) throw new PreviewError("invalid_baseline");
    const now = clock();
    const identity = await read<Page<{ id?: string }>>("channels", {
      part: "id",
      mine: "true",
    });
    if (identity.items?.length !== 1 || identity.items[0].id !== channel) {
      throw new PreviewError("youtube_channel_mismatch");
    }
    let reconciled = 0;
    let recoveryErrors = 0;
    if (mode === "run") {
      const pending = await rpc<Claim[]>("pending", { p_channel: channel });
      for (const claim of pending) {
        try {
          if (await reconcile(channel, claim)) reconciled++;
        } catch (error) {
          if (
            !(error instanceof PreviewError) ||
            !["youtube_read_failed", "youtube_reply_check_partial"].includes(
              error.message,
            )
          ) throw error;
          recoveryErrors++;
        }
      }
    }
    const rules = await templates();
    const seen = new Set<string>();
    const candidates: {
      comment_id: string;
      template_key: string;
      reply_text: string;
      author: string;
      published_at: string;
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
        const rule = matchGlobalKeyword(rules, comment.snippet?.textDisplay ?? "");
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
        if (mode === "preview" && candidates.length >= dailyLimit) {
          skipped.limit++;
          continue;
        }
        candidates.push({
          comment_id: id,
          template_key: rule.id,
          reply_text: rule.reply_text,
          author,
          published_at: new Date(published).toISOString(),
        });
      }
    } while (pageToken && pages < maxPages);
    let sends = 0;
    const delivery: Record<string, number> = {};
    if (mode === "run" && candidates.length) {
      const known = new Set(
        await rpc<string[]>("known", {
          p_channel: channel,
          p_comments: candidates.map(({ comment_id }) => comment_id),
        }),
      );
      for (
        const candidate of candidates.filter(({ comment_id }) =>
          comment_id === target && !known.has(comment_id)
        ).slice(0, 1)
      ) {
        let result: string;
        try {
          result = await deliver(channel, candidate);
        } catch (error) {
          if (
            !(error instanceof PreviewError) ||
            !["youtube_read_failed", "youtube_reply_check_partial"].includes(
              error.message,
            )
          ) throw error;
          result = "reply_check_failed";
        }
        delivery[result] = (delivery[result] ?? 0) + 1;
        if (result === "sent") sends++;
        if (result === "reconciled") reconciled++;
        if (
          ["quota", "daily_limit", "disabled", "day_rollover"].includes(result)
        ) break;
      }
    }
    return {
      status: pageToken ? "partial" : "pass",
      checked,
      skipped,
      candidates: mode === "preview"
        ? candidates.map(({ comment_id, template_key, reply_text }) => ({
          comment_id,
          template_key,
          reply_text,
        }))
        : [],
      daily_reply_limit: dailyLimit,
      poll_interval_minutes: pollIntervalMinutes,
      sends,
      reconciled,
      recovery_errors: recoveryErrors,
      delivery,
      production: "NO_GO",
    };
  };
}

const preview = createYoutubePreview();
export async function handleYoutubePreview(mode: "preview" | "run", target?: string) {
  try {
    return Response.json(await preview(mode, target));
  } catch (error) {
    const code = error instanceof PreviewError
      ? error.message
      : "youtube_preview_failed";
    return Response.json({
      error: code,
      sends: mode === "preview" || code === "youtube_send_disabled" ? 0 : null,
      production: "NO_GO",
    }, {
      status: code === "youtube_send_disabled"
        ? 403
        : /quota_exhausted|rate_limited/.test(code)
        ? 429
        : 502,
    });
  }
}
