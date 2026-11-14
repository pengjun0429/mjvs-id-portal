function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function isConfigured(env) {
  return env?.MJVS_PUBLIC_LOOKUP_ENABLED === "true"
    && Boolean(env?.MJVS_SPREADSHEET_ID)
    && Boolean(env?.MJVS_GOOGLE_SERVICE_ACCOUNT_JSON)
    && Boolean(env?.TURNSTILE_SITE_KEY)
    && Boolean(env?.TURNSTILE_SECRET_KEY)
    && Boolean(env?.LOOKUP_RATE_LIMIT_PEPPER)
    && Boolean(env?.LOOKUP_RATE_LIMITER);
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const lookupEnabled = isConfigured(env);
  return json({
    lookupEnabled,
    turnstileSiteKey: lookupEnabled ? String(env.TURNSTILE_SITE_KEY) : null,
  });
}
