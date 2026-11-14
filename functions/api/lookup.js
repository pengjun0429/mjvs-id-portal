const MESSAGE_NOT_READY = "名錄尚未啟用或無法確認，目前不能核實此 ID。";
const MESSAGE_NOT_LISTED = "沒有在免簽名單之內";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const TURNSTILE_ENDPOINT = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_BODY_LENGTH = 2048;
const MAX_REGISTRY_ROWS = 5000;
const TOKEN_CACHE_MARGIN_MS = 60_000;

let tokenCache = { subject: "", accessToken: "", expiresAt: 0 };

function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

function unavailable(code = "registry_not_ready") {
  return json({ error: code, message: MESSAGE_NOT_READY }, 503);
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

function normalizeId(value) {
  if (typeof value !== "string") return null;
  const id = value.normalize("NFKC").trim().toUpperCase();
  if (!id || id.length > 128 || /[\u0000-\u001f\u007f]/u.test(id)) return null;
  return id;
}

function isBlank(value) {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

async function fetchJson(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok || text.length > 4_000_000) return null;
    try { return JSON.parse(text); } catch { return null; }
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function bytesToBase64Url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function privateKeyBytes(pem) {
  if (typeof pem !== "string") return null;
  const normalized = pem.replace(/\\n/g, "\n");
  const base64 = normalized.replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  } catch {
    return null;
  }
}

async function createSignedAssertion(serviceAccount) {
  const pkcs8 = privateKeyBytes(serviceAccount.private_key);
  if (!pkcs8) return null;
  try {
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const issuedAt = Math.floor(Date.now() / 1000);
    const header = bytesToBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = bytesToBase64Url(JSON.stringify({
      iss: serviceAccount.client_email,
      scope: SHEETS_SCOPE,
      aud: TOKEN_ENDPOINT,
      iat: issuedAt,
      exp: issuedAt + 3600,
    }));
    const unsigned = `${header}.${claims}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
    return `${unsigned}.${bytesToBase64Url(signature)}`;
  } catch {
    return null;
  }
}

async function getGoogleAccessToken(env) {
  let serviceAccount;
  try { serviceAccount = JSON.parse(env.MJVS_GOOGLE_SERVICE_ACCOUNT_JSON); } catch { return null; }
  if (typeof serviceAccount?.client_email !== "string" || typeof serviceAccount?.private_key !== "string") return null;

  const now = Date.now();
  if (tokenCache.subject === serviceAccount.client_email
      && tokenCache.accessToken
      && tokenCache.expiresAt - TOKEN_CACHE_MARGIN_MS > now) {
    return tokenCache.accessToken;
  }

  const assertion = await createSignedAssertion(serviceAccount);
  if (!assertion) return null;
  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const result = await fetchJson(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (typeof result?.access_token !== "string" || !Number.isFinite(Number(result.expires_in))) return null;

  tokenCache = {
    subject: serviceAccount.client_email,
    accessToken: result.access_token,
    expiresAt: now + Number(result.expires_in) * 1000,
  };
  return tokenCache.accessToken;
}

async function verifyTurnstile(token, env, expectedHostname) {
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  const result = await fetchJson(TURNSTILE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token }),
  });
  return result?.success === true
    && result.hostname === expectedHostname
    && result.action === "mjvs_lookup";
}

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function checkRateLimit(request, env) {
  const clientIp = request.headers.get("CF-Connecting-IP");
  if (!clientIp || !env.LOOKUP_RATE_LIMITER || !env.LOOKUP_RATE_LIMIT_PEPPER) return null;
  try {
    const actorKey = await hmacHex(env.LOOKUP_RATE_LIMIT_PEPPER, clientIp);
    const id = env.LOOKUP_RATE_LIMITER.idFromName(actorKey);
    const stub = env.LOOKUP_RATE_LIMITER.get(id);
    const response = await stub.fetch("https://mjvs-limiter.internal/check", { method: "POST" });
    if (response.status === 429) {
      const body = await response.json().catch(() => ({}));
      return { allowed: false, retryAfter: Math.max(1, Number(body.retryAfter) || 60) };
    }
    if (!response.ok) return null;
    const body = await response.json();
    return body?.allowed === true ? { allowed: true } : null;
  } catch {
    return null;
  }
}

async function readIdStatusColumns(env, accessToken) {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.MJVS_SPREADSHEET_ID)}/values:batchGet`);
  url.searchParams.append("ranges", "'名錄'!A1:A5002");
  url.searchParams.append("ranges", "'名錄'!E1:E5002");
  url.searchParams.set("majorDimension", "ROWS");
  url.searchParams.set("valueRenderOption", "UNFORMATTED_VALUE");
  return fetchJson(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

function validateRegistry(valueRanges, queriedId) {
  if (!Array.isArray(valueRanges) || valueRanges.length !== 2) return null;
  const idRows = valueRanges[0]?.values;
  const statusRows = valueRanges[1]?.values;
  if (!Array.isArray(idRows) || !Array.isArray(statusRows)) return null;
  if (idRows[0]?.[0] !== "id" || statusRows[0]?.[0] !== "status") return null;

  const rowCount = Math.max(idRows.length, statusRows.length) - 1;
  if (rowCount < 1 || rowCount > MAX_REGISTRY_ROWS) return null;

  const seen = new Set();
  let matchedStatus = null;
  for (let rowIndex = 1; rowIndex <= rowCount; rowIndex += 1) {
    const rawId = idRows[rowIndex]?.[0];
    const rawStatus = statusRows[rowIndex]?.[0];
    if (isBlank(rawId) && isBlank(rawStatus)) continue;
    if (isBlank(rawId) || isBlank(rawStatus) || typeof rawId !== "string" || typeof rawStatus !== "string") return null;

    const id = normalizeId(rawId);
    const status = rawStatus.trim().toLowerCase();
    if (!id || !["active", "suspended", "revoked"].includes(status) || seen.has(id)) return null;
    seen.add(id);
    if (id === queriedId) matchedStatus = status;
  }
  if (seen.size === 0) return null;
  return matchedStatus === null ? "not_found" : matchedStatus;
}

export async function onRequest({ request, env }) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { Allow: "POST" });

  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "origin_not_allowed" }, 403);
  if (!isConfigured(env)) return unavailable();

  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") || "")) {
    return json({ error: "json_required" }, 415);
  }

  let rawBody;
  try { rawBody = await request.text(); } catch { return json({ error: "invalid_json" }, 400); }
  if (rawBody.length > MAX_BODY_LENGTH) return json({ error: "request_too_large" }, 413);

  let payload;
  try { payload = JSON.parse(rawBody); } catch { return json({ error: "invalid_json" }, 400); }
  const id = normalizeId(payload?.id);
  if (!id) return json({ error: "invalid_id" }, 400);

  const rateLimit = await checkRateLimit(request, env);
  if (!rateLimit) return unavailable("lookup_protection_unavailable");
  if (!rateLimit.allowed) {
    return json({ error: "rate_limited" }, 429, { "Retry-After": String(rateLimit.retryAfter) });
  }

  const hostname = new URL(request.url).hostname;
  const captchaValid = await verifyTurnstile(payload?.captchaToken, env, hostname);
  if (!captchaValid) return json({ error: "captcha_invalid" }, 403);

  try {
    const accessToken = await getGoogleAccessToken(env);
    if (!accessToken) return unavailable("registry_unavailable");
    const sheet = await readIdStatusColumns(env, accessToken);
    const matchedStatus = validateRegistry(sheet?.valueRanges, id);
    if (matchedStatus === null) return unavailable("registry_not_ready");
    if (matchedStatus !== "active") return json({ valid: false, message: MESSAGE_NOT_LISTED });
    return json({
      valid: true,
      message: "此 ID 有效；實際免簽待遇仍須依目的地與個別生效互惠協議確認。",
    });
  } catch {
    return unavailable("registry_unavailable");
  }
}
