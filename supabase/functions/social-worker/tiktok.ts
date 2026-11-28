const commentsEndpoint =
  "https://business-api.tiktok.com/open_api/v1.3/business/comment/list/";
const pageSize = 20;
const maxPages = 3;

type Comment = {
  comment_id?: unknown;
  video_id?: unknown;
  status?: unknown;
  owner?: unknown;
  parent_comment_id?: unknown;
  replies?: unknown;
};

function result(body: Record<string, unknown>, status = 200): Response {
  return Response.json({ ...body, sends: 0, production: "NO_GO" }, { status });
}

export function createTikTokPreview({
  env = (key: string) => Deno.env.get(key),
  request = fetch,
}: { env?: (key: string) => string | undefined; request?: typeof fetch } = {}) {
  return async function preview(): Promise<Response> {
    const businessId = env("TIKTOK_BUSINESS_ID");
    const videoId = env("TIKTOK_OWNED_VIDEO_ID");
    const token = env("TIKTOK_ACCESS_TOKEN");
    if (
      !businessId?.trim() || !videoId || !/^\d{1,24}$/.test(videoId) ||
      !token?.trim()
    ) {
      return result({ error: "tiktok_missing_configuration" }, 503);
    }

    const seen = new Set<string>();
    let cursor: number | undefined;
    let checked = 0;
    let unreplied = 0;
    for (let page = 0; page < maxPages; page++) {
      const url = new URL(commentsEndpoint);
      url.search = new URLSearchParams({
        business_id: businessId,
        video_id: videoId,
        status: "PUBLIC",
        include_replies: "false",
        page_size: String(pageSize),
        ...(cursor === undefined ? {} : { cursor: String(cursor) }),
      }).toString();

      try {
        const response = await request(url, {
          method: "GET",
          headers: { "Access-Token": token },
          redirect: "error",
          signal: AbortSignal.timeout(6000),
        });
        if (response.status === 429) {
          return result({ error: "tiktok_rate_limited" }, 429);
        }
        if (!response.ok) return result({ error: "tiktok_read_failed" }, 502);
        const body = await response.json();
        if (body?.code !== 0) {
          return result({ error: "tiktok_read_failed" }, 502);
        }
        const data = body.data;
        if (
          !Array.isArray(data?.comments) || data.comments.length > pageSize ||
          typeof data.has_more !== "boolean"
        ) {
          return result({ error: "tiktok_invalid_response" }, 502);
        }
        for (const comment of data.comments as (Comment | null)[]) {
          checked++;
          if (
            comment?.video_id !== videoId || comment.status !== "PUBLIC" ||
            comment.owner !== false || comment.parent_comment_id != null ||
            comment.replies !== 0 ||
            typeof comment.comment_id !== "string" ||
            !/^\d{1,24}$/.test(comment.comment_id) ||
            seen.has(comment.comment_id)
          ) continue;
          seen.add(comment.comment_id);
          unreplied++;
        }
        if (!data.has_more) {
          return result({ status: "pass", checked, unreplied });
        }
        if (
          !Number.isSafeInteger(data.cursor) || data.cursor < 0 ||
          (cursor !== undefined && data.cursor <= cursor)
        ) {
          return result({ error: "tiktok_invalid_pagination" }, 502);
        }
        cursor = data.cursor;
      } catch {
        return result({ error: "tiktok_read_failed" }, 502);
      }
    }
    return result({ status: "partial", checked, unreplied });
  };
}

export const handleTikTokPreview = createTikTokPreview();
