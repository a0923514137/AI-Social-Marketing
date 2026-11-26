import { handleRequest } from "./index.ts";
const key = "test-only-key-012345678901234567890123456789";
async function check(
  body: unknown,
  status: number,
  error: string,
  authorized = true,
  method = "POST",
) {
  const old = Deno.env.get("SOCIAL_SCHEDULER_KEY");
  Deno.env.set("SOCIAL_SCHEDULER_KEY", key);
  try {
    const response = await handleRequest(
      new Request("https://example.invalid", {
        method,
        headers: authorized ? { "x-social-scheduler-key": key } : {},
        body: method === "POST" ? JSON.stringify(body) : undefined,
      }),
    );
    const result = await response.json();
    if (response.status !== status || result.error !== error) {
      throw new Error(JSON.stringify({ status: response.status, result }));
    }
  } finally {
    if (old === undefined) Deno.env.delete("SOCIAL_SCHEDULER_KEY");
    else Deno.env.set("SOCIAL_SCHEDULER_KEY", old);
  }
}
Deno.test("unauthorized", () => check({}, 401, "unauthorized", false));
Deno.test("method", () => check({}, 405, "method_not_allowed", true, "GET"));
Deno.test("unknown task", () =>
  check({ task: "unknown" }, 400, "unknown_task"));
for (const task of ["instagram_patrol", "facebook_preview"]) {
  Deno.test(
    task + " blocks run",
    () => check({ task, mode: "run" }, 403, "preview_only"),
  );
}
Deno.test("youtube blocks non-test target", () =>
  check(
    { task: "youtube_poll", mode: "run", comment_id: "invalid" },
    403,
    "single_target_required",
  ));
Deno.test("invalid threads mode", () =>
  check({ task: "threads_scan", mode: "invalid" }, 400, "invalid_mode"));
