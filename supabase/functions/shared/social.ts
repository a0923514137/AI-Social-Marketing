export type Platform = "instagram" | "facebook" | "threads";
type Rule = {
  keyword: string;
  reply_text: string;
  global: boolean;
  post_ids: string[];
};

export const normalize = (text: string) =>
  text.normalize("NFKC").trim().toLowerCase();

export function matchRule(
  rules: Rule[],
  post: string,
  text: string,
): Rule | undefined {
  const normalized = normalize(text);
  const matching = rules.filter((rule) => {
    const keyword = normalize(rule.keyword);
    return keyword && normalized.includes(keyword) &&
      (rule.post_ids.includes(post) || rule.global);
  });
  return matching.sort((a, b) =>
    Number(b.post_ids.includes(post)) - Number(a.post_ids.includes(post)) ||
    normalize(b.keyword).length - normalize(a.keyword).length
  )[0];
}

export function socialDatabase(
  base: string,
  service: string,
  request = fetch,
) {
  async function rest<T>(
    path: string,
    method = "GET",
    payload?: unknown,
  ): Promise<T> {
    const response = await request(new URL("/rest/v1/" + path, base), {
      method,
      headers: {
        apikey: service,
        Authorization: "Bearer " + service,
        "content-type": "application/json",
        Prefer: "return=representation",
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) throw new Error("database_http_" + response.status);
    return await response.json() as T;
  }

  const rpc = <T>(name: string, payload: unknown) =>
    rest<T>("rpc/" + name, "POST", payload);

  async function rules(platform: Platform) {
    return await rpc<Rule[]>("social_rules", { p_platform: platform });
  }

  async function activation() {
    const rows = await rest<
      { enabled: boolean; activated_at: string | null }[]
    >(
      "social_reply_switch?singleton=eq.true&select=enabled,activated_at",
    );
    if (!Array.isArray(rows) || rows.length !== 1) return null;
    const [row] = rows;
    return row?.enabled === true && typeof row.activated_at === "string" &&
        Number.isFinite(Date.parse(row.activated_at))
      ? row.activated_at
      : null;
  }

  return { rest, rpc, rules, activation };
}

export type SocialDatabase = ReturnType<typeof socialDatabase>;
export type Delivery = {
  state: "sent" | "failed" | "uncertain";
  responseId?: string;
  errorCode?: string;
};
export const sendConfigured = (platform: Platform) =>
  Deno.env.get("SOCIAL_SEND_ENABLED") === "true" &&
  (platform === "threads" ||
    Deno.env.get(
        platform === "facebook"
          ? "SOCIAL_FB_SEND_ENABLED"
          : "SOCIAL_IG_SEND_ENABLED",
      ) === "true");

export function eligible(timestamp: unknown, activation: string | null) {
  const created = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
  return activation !== null && created > Date.parse(activation) &&
    created <= Date.now();
}

export async function deliver(db: SocialDatabase, item: {
  platform: Platform;
  comment: string;
  post: string;
  timestamp: string;
  activation: string | null;
}, publish: () => Promise<Delivery>) {
  const { platform, comment, post, timestamp, activation } = item;
  if (!sendConfigured(platform) || !eligible(timestamp, activation)) {
    return "disabled";
  }
  const reserved = await db.rpc<boolean>("social_reserve_reply", {
    p_platform: platform,
    p_comment: comment,
    p_post: post,
    p_created: timestamp,
    p_activation: activation,
  });
  if (reserved !== true) return "skipped";

  let outcome: Delivery;
  try {
    outcome =
      sendConfigured(platform) && await db.activation() === activation &&
        sendConfigured(platform)
        ? await publish()
        : { state: "failed", errorCode: "disabled_before_send" };
  } catch {
    outcome = { state: "uncertain", errorCode: "delivery_unknown" };
  }
  const query = new URLSearchParams({
    platform: "eq." + platform,
    comment_id: "eq." + comment,
    state: "eq.sending",
  });
  try {
    const rows = await db.rest<unknown[]>(
      "r54_reply_claims?" + query,
      "PATCH",
      {
        state: outcome.state,
        response_id: outcome.responseId ?? null,
        error_code: outcome.errorCode ?? null,
        updated_at: new Date().toISOString(),
      },
    );
    if (!Array.isArray(rows) || rows.length !== 1) return "uncertain";
    return outcome.state;
  } catch {
    // The permanent claim stays in place if recording the delivery fails.
    return "uncertain";
  }
}

export function graphDelivery(
  response: Response,
  data: { id?: unknown } | null,
): Delivery {
  if (response.ok && typeof data?.id === "string" && data.id) {
    return { state: "sent", responseId: data.id };
  }
  const definiteFailure = response.status >= 400 && response.status < 500 &&
    response.status !== 408 && response.status !== 429;
  return {
    state: definiteFailure ? "failed" : "uncertain",
    errorCode: "graph_http_" + response.status,
  };
}
