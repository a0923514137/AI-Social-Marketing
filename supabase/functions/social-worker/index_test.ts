import { handleRequest } from "./index.ts";

const testKey = "test-only-scheduler-key-1234567890";

Deno.env.set("SOCIAL_SCHEDULER_KEY", testKey);
Deno.env.set("SOCIAL_SEND_ENABLED", "false");
Deno.env.set("SOCIAL_TELEGRAM_ENABLED", "false");

function request(
  body: string,
  key = testKey,
  method = "POST"
): Request {
  return new Request("http://localhost/social-worker", {
    method,
    headers: {
      "content-type": "application/json",
      "x-social-scheduler-key": key
    },
    body: method === "POST" ? body : undefined
  });
}

async function expectStatus(
  req: Request,
  expected: number
) {
  const response = await handleRequest(req);

  if (response.status !== expected) {
    throw new Error(
      `Expected ${expected}, got ${response.status}`
    );
  }

  await response.text();
}

Deno.test("Reject non-POST request", async () => {
  await expectStatus(request("", testKey, "GET"), 405);
});

Deno.test("Reject invalid scheduler key", async () => {
  await expectStatus(request("{}", "wrong-key"), 401);
});

Deno.test("Reject invalid JSON", async () => {
  await expectStatus(request("{invalid"), 400);
});

Deno.test("Reject null payload", async () => {
  await expectStatus(request("null"), 400);
});

Deno.test("Reject unknown task", async () => {
  await expectStatus(
    request(JSON.stringify({
      task: "unknown"
    })),
    400
  );
});

Deno.test("Reject invalid mode", async () => {
  await expectStatus(
    request(JSON.stringify({
      task: "threads_scan",
      mode: "invalid"
    })),
    400
  );
});

Deno.test("Reject oversized request", async () => {
  await expectStatus(request("x".repeat(4097)), 413);
});

Deno.test("Reject slow request", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start() {
      // Simulate a stalled request body.
    }
  });

  const req = new Request(
    "http://localhost/social-worker",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-social-scheduler-key": testKey
      },
      body: stream
    }
  );

  await expectStatus(req, 408);
});

Deno.test("Allow safe preview request", async () => {
  await expectStatus(
    request(JSON.stringify({
      task: "threads_patrol",
      mode: "preview"
    })),
    200
  );
});
