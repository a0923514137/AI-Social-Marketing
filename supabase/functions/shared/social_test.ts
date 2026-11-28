import { deliver, socialDatabase } from "./social.ts";

function expect(actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error("expected " + expected + ", received " + actual);
  }
}

const activation = "2025-01-01T00:00:00Z";
const item = {
  platform: "facebook" as const,
  comment: "comment-42",
  post: "post-21",
  timestamp: "2025-01-01T00:00:01Z",
  activation,
};

Deno.test("activation requires exactly one valid enabled singleton", async () => {
  for (
    const [rows, expected] of [
      [[{ enabled: true, activated_at: activation }], activation],
      [[{ enabled: "false", activated_at: activation }], null],
      [[{ enabled: true, activated_at: "invalid" }], null],
      [[{ enabled: true, activated_at: activation }, {}], null],
      [{ enabled: true, activated_at: activation }, null],
    ] as const
  ) {
    const db = socialDatabase(
      "https://example.invalid",
      "fixture",
      () => Promise.resolve(Response.json(rows)),
    );
    expect(await db.activation(), expected);
  }
});

Deno.test("shared delivery checks the environment after the DB read and keeps the claim", async () => {
  const globalGate = "SOCIAL_SEND_ENABLED";
  const platformGate = "SOCIAL_FB_SEND_ENABLED";
  const target = "SOCIAL_FB_SINGLE_TEST_COMMENT_ID";
  const originalTarget = Deno.env.get(target);
  const originalGlobal = Deno.env.get(globalGate);
  const originalPlatform = Deno.env.get(platformGate);

  Deno.env.set(globalGate, "true");
  Deno.env.set(platformGate, "true");
  Deno.env.delete(target);
  try {
    let claimExists = false;
    let finalized = 0;
    let publishAttempts = 0;
    const db = socialDatabase(
      "https://example.invalid",
      "fixture",
      async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/rpc/social_reserve_reply")) {
          const reserved = !claimExists;
          claimExists = true;
          return Response.json(reserved);
        }
        if (path.endsWith("/social_reply_switch")) {
          await Promise.resolve();
          Deno.env.set(platformGate, "false");
          return Response.json([{ enabled: true, activated_at: activation }]);
        }
        if (path.endsWith("/r54_reply_claims") && init?.method === "PATCH") {
          const body = JSON.parse(String(init.body));
          expect(body.state, "failed");
          expect(body.error_code, "disabled_before_send");
          finalized++;
          return Response.json([{}]);
        }
        throw new Error("unexpected database request");
      },
    );

    const publish = () => {
      publishAttempts++;
      return Promise.resolve({ state: "sent" as const });
    };
    expect(await deliver(db, item, publish), "disabled");
    Deno.env.set(target, "another-comment");
    expect(await deliver(db, item, publish), "disabled");
    expect(claimExists, false);
    Deno.env.set(target, item.comment);
    const outcomes = await Promise.all([
      deliver(db, item, publish),
      deliver(db, item, publish),
    ]);
    expect(outcomes.join(","), "failed,skipped");
    expect(finalized, 1);
    expect(publishAttempts, 0);
    Deno.env.set(platformGate, "true");
    expect(await deliver(db, item, publish), "skipped");
    expect(publishAttempts, 0);
  } finally {
    if (originalTarget === undefined) Deno.env.delete(target);
    else Deno.env.set(target, originalTarget);
    if (originalGlobal === undefined) Deno.env.delete(globalGate);
    else Deno.env.set(globalGate, originalGlobal);
    if (originalPlatform === undefined) Deno.env.delete(platformGate);
    else Deno.env.set(platformGate, originalPlatform);
  }
});
