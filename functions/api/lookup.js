const PUBLIC_CSV_URL = "https://docs.google.com/spreadsheets/d/1A6Pcriu-xDtgUSM0oPHx362QApUg_-KkSmCmK_FUVFU/gviz/tq?tqx=out:csv&gid=1037470539&tq=select%20A%2CE";
const MESSAGE_NOT_READY = "名錄尚未啟用或無法確認，目前不能核實此 ID。";
const MESSAGE_NOT_LISTED = "沒有在免簽名單之內";
const TURNSTILE_ENDPOINT = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_BODY_LENGTH = 2048;
const MAX_CSV_BYTES = 2_000_000;
const MAX_REGISTRY_ROWS = 5000;

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
    && Boolean(env?.TURNSTILE_SITE_KEY)
    && Boolean(env?.TURNSTILE_SECRET_KEY)
    && typeof env?.LOOKUP_RATE_LIMIT_PEPPER === "string"
    && env.LOOKUP_RATE_LIMIT_PEPPER.length >= 32
    && Boolean(env?.LOOKUP_RATE_LIMITER);
}

function normalizeId(value) {
  if (typeof value !== "string") return null;
  const id = value.normalize("NFKC").trim().toUpperCase();
  if (!id || id.length > 128 || /[\u0000-\u001f\u007f]/u.test(id)) return null;
  return id;
}

async function fetchLimitedText(url, options = {}, timeoutMs = 10_000, maxBytes = MAX_CSV_BYTES) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) return null;
    const contentLength = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) return null;
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) return null;
    return { contentType: response.headers.get("Content-Type") || "", text };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, options = {}, maxBytes = 32_768) {
  const result = await fetchLimitedText(url, options, 10_000, maxBytes);
  if (!result) return null;
  try { return JSON.parse(result.text); } catch { return null; }
}

function parseCsv(text) {
  if (typeof text !== "string") return null;
  const source = text.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
        afterQuote = true;
      } else {
        field += char;
      }
      continue;
    }

    if (afterQuote && char !== "," && char !== "\n" && char !== "\r") return null;
    if (char === '"') {
      if (field !== "" || afterQuote) return null;
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
      afterQuote = false;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      afterQuote = false;
    } else {
      field += char;
    }
  }

  if (quoted) return null;
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function validateRegistry(csvText, queriedId) {
  const rows = parseCsv(csvText);
  if (!rows?.length) return null;
  const expectedHeaders = ["id", "status"];
  const headers = rows[0].map((value) => value.trim());
  if (headers.length !== expectedHeaders.length || headers.some((value, index) => value !== expectedHeaders[index])) return null;

  const records = rows.slice(1).filter((record) => record.some((cell) => cell.trim() !== ""));
  if (records.length < 1 || records.length > MAX_REGISTRY_ROWS) return null;

  const seen = new Set();
  let matchedStatus = null;
  for (const record of records) {
    if (record.length !== expectedHeaders.length) return null;
    const id = normalizeId(record[0]);
    const status = record[1].trim().toLowerCase();
    if (!id || !["active", "suspended", "revoked"].includes(status) || seen.has(id)) return null;
    seen.add(id);
    if (id === queriedId) matchedStatus = status;
  }

  if (seen.size === 0) return null;
  return matchedStatus === null ? "not_found" : matchedStatus;
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

async function readPublicIdStatusCsv() {
  const result = await fetchLimitedText(PUBLIC_CSV_URL, {
    method: "GET",
    headers: { Accept: "text/csv" },
    cache: "no-store",
  });
  if (!result || !/text\/csv/i.test(result.contentType)) return null;
  return result.text;
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
    const csvText = await readPublicIdStatusCsv();
    if (csvText === null) return unavailable("registry_unavailable");
    const matchedStatus = validateRegistry(csvText, id);
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
