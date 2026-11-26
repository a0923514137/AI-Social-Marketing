const env = (name: string) => Deno.env.get(name) || "";
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {"content-type":"application/json"}
  });

Deno.serve(async (req) => {
  if (req.method !== "POST")
    return json({error:"method_not_allowed"},405);

  const key = env("SOCIAL_SCHEDULER_KEY");
  if (key.length < 32 ||
      req.headers.get("x-social-scheduler-key") !== key)
    return json({error:"unauthorized"},401);

  const now = Math.floor(Date.now()/1000);
  const results = [];

  for (const platform of ["facebook","instagram","threads"]) {
    const token = env(
      platform === "facebook" ? "FB_PAGE_ACCESS_TOKEN" :
      platform === "instagram" ? "INSTAGRAM_ACCESS_TOKEN" :
      "THREADS_ACCESS_TOKEN"
    );
    const expiry = Number(env(
      platform === "facebook" ? "FB_TOKEN_EXPIRES_AT" :
      platform === "instagram" ? "IG_TOKEN_EXPIRES_AT" :
      "THREADS_TOKEN_EXPIRES_AT"
    ) || "0");
    const dataExpiry = platform === "threads" ? 0 :
      Number(env("META_DATA_ACCESS_EXPIRES_AT") || "0");
    const expected = platform === "facebook" ? env("FB_PAGE_ID") :
      platform === "instagram" ? env("IG_BUSINESS_ACCOUNT_ID") :
      env("THREADS_ACCOUNT_ID");

    let status = "error";
    let http = 0;
    let errorCode = null;

    try {
      if (!token || !expected ||
          !Number.isFinite(expiry) ||
          !Number.isFinite(dataExpiry))
        throw new Error("missing_configuration");

      const url = platform === "threads"
        ? "https://graph.threads.net/v1.0/me?fields=id"
        : "https://graph.facebook.com/v27.0/" +
          encodeURIComponent(expected) + "?fields=id";

      const response = await fetch(url, {
        headers:{Authorization:"Bearer "+token},
        signal:AbortSignal.timeout(10000)
      });
      http = response.status;
      const data = await response.json();
      errorCode = Number(data?.error?.code) || null;

      if (!response.ok) {
        status = errorCode === 190 ? "invalid" : "error";
      } else if (String(data.id) !== expected) {
        status = "invalid";
      } else {
        const dates = [expiry,dataExpiry].filter(x=>x>0);
        status = dates.some(x=>x<=now) ? "expired" :
          dates.some(x=>x-now<=604800) ? "expiring" :
          dates.length ? "healthy" : "reachable_expiry_unknown";
      }
    } catch {
      status = "error";
    }

    results.push({platform,status,http,error_code:errorCode});
  }

  return json({
    mode:"health_preview",
    results,
    refreshed:0,
    writes:0,
    sent:0
  });
});