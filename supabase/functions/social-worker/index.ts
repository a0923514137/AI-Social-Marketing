import { keywordSearch, resolvePost } from "./threads_discovery.ts";
import instagramReply from "./instagram_reply.ts";
import facebookPreview from "./facebook_preview.ts";
import scan from "./threads_scan.ts";
import patrol from "./threads_patrol.ts";
import { handleYoutubePreview } from "./youtube.ts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });

export async function handleRequest(
  req: Request,
): Promise<Response> {
  const discoveryTask = new URL(req.url).searchParams.get("task");
  if (discoveryTask === "threads_resolve_post") return resolvePost(req);
  if (discoveryTask === "threads_keyword_search") return keywordSearch(req);
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const key = Deno.env.get("SOCIAL_SCHEDULER_KEY") || "";

  const socialAuthorized = key.length >= 32 &&
    req.headers.get("x-social-scheduler-key") === key;
  const ytKey = Deno.env.get("YOUTUBE_SCHEDULER_KEY") || "";
  const youtubeAuthorized = ytKey.length >= 32 &&
    req.headers.get("x-youtube-scheduler-key") === ytKey &&
    Deno.env.get("SUPABASE_URL") === "https://vnvrkbeyrhatbnjhglmv.supabase.co";
  if (!socialAuthorized && !youtubeAuthorized) {
    return json({ error: "unauthorized" }, 401);
  }

  const maxBytes = 4096;
  const reader = req.body?.getReader();

  if (!reader) {
    return json({ error: "invalid_json" }, 400);
  }

  let raw = "";
  let totalBytes = 0;
  const decoder = new TextDecoder();

  const readTimeoutMs = 5000;
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, readTimeoutMs);

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (timedOut) {
        return json({ error: "request_timeout" }, 408);
      }

      if (done) break;

      totalBytes += value.byteLength;

      if (totalBytes > maxBytes) {
        void reader.cancel().catch(() => {});
        return json({ error: "payload_too_large" }, 413);
      }

      raw += decoder.decode(value, { stream: true });
    }

    raw += decoder.decode();
  } catch {
    if (timedOut) {
      return json({ error: "request_timeout" }, 408);
    }

    return json({ error: "invalid_body" }, 400);
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }

  let input: unknown;

  try {
    input = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    return json({ error: "invalid_payload" }, 400);
  }

  const x = input as Record<string, unknown>;

  const task = x.task;
  const mode = x.mode === undefined ? "preview" : x.mode;

  if (!socialAuthorized && (task !== "youtube_poll" || mode !== "preview")) {
    return json({ error: "unauthorized" }, 401);
  }

  if (
    task === "instagram_patrol" || task === "instagram_reply" ||
    task === "facebook_preview"
  ) {
    const valid = mode === "preview" ||
      (task === "instagram_reply" && mode === "run") ||
      (task === "facebook_preview" && mode === "simulate");
    if (!socialAuthorized || !valid) {
      return json({ error: "preview_only" }, 403);
    }
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!service) return json({ error: "missing_service_key" }, 503);
    const handler = task === "facebook_preview"
      ? facebookPreview
      : instagramReply;
    try {
      return await handler(
        new Request(req.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "authorization": "Bearer " + service,
          },
          body: JSON.stringify({ mode, events: x.events }),
        }),
      );
    } catch {
      return json({ error: "preview_failed" }, 502);
    }
  }

  if (task === "youtube_poll") {
    if (mode !== "preview") return json({ error: "youtube_preview_only", sends: 0, production: "NO_GO" }, 403);
    return handleYoutubePreview("preview");
  }

  if (
    task !== "threads_scan" &&
    task !== "threads_patrol"
  ) {
    return json({ error: "unknown_task" }, 400);
  }

  const allowedModes = task === "threads_scan"
    ? ["preview", "scan_preview", "scan"]
    : ["preview", "scan_preview", "run_preview", "run"];

  if (
    typeof mode !== "string" ||
    !allowedModes.includes(mode)
  ) {
    return json({ error: "invalid_mode" }, 400);
  }

  const handler = task === "threads_scan" ? scan : patrol;

  try {
    return await handler(
      new Request(req.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-social-scheduler-key": key,
        },
        body: JSON.stringify({ mode }),
      }),
    );
  } catch {
    return json({
      error: "worker_execution_failed",
      delivery: "unknown",
    }, 502);
  }
}

if (import.meta.main) {
  Deno.serve(handleRequest);
}
