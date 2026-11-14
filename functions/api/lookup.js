const REGISTRY_NOT_READY = "正式名錄尚未完成設定，目前無法確認此 ID 是否在免簽名單內。";

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
  return json({ error: code, message: REGISTRY_NOT_READY }, 503);
}

function normalizeId(value) {
  if (typeof value !== "string") return null;
  const id = value.normalize("NFKC").trim().toUpperCase();
  if (!id || id.length > 128 || /[\u0000-\u001f\u007f]/u.test(id)) return null;
  return id;
}

async function digestId(id, pepper) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function onRequest({ request, env }) {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
  }

  const requestOrigin = request.headers.get("Origin");
  if (requestOrigin && requestOrigin !== new URL(request.url).origin) {
    return json({ error: "origin_not_allowed" }, 403);
  }

  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > 2048) return json({ error: "request_too_large" }, 413);

  // Fail closed before reading or hashing an ID while the private registry is not bound and ready.
  if (!env?.DB || !env?.ID_LOOKUP_PEPPER) return unavailable();

  try {
    const readiness = await env.DB
      .prepare("SELECT is_ready FROM registry_control WHERE id = ? LIMIT 1")
      .bind(1)
      .first();
    if (Number(readiness?.is_ready) !== 1) return unavailable();
  } catch {
    return unavailable("registry_unavailable");
  }

  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") || "")) {
    return json({ error: "json_required" }, 415);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const id = normalizeId(payload?.id);
  if (!id) return json({ error: "invalid_id" }, 400);

  try {
    const idHash = await digestId(id, env.ID_LOOKUP_PEPPER);
    const record = await env.DB
      .prepare(`SELECT country_name, registered_name, public_name_authorized
                FROM issued_ids
                WHERE id_hash = ? AND status = 'active'
                LIMIT 1`)
      .bind(idHash)
      .first();

    if (!record) {
      return json({ found: false, message: "沒有在免簽名單之內" });
    }

    // Do not disclose a person's name unless the record was explicitly approved for public lookup.
    if (Number(record.public_name_authorized) !== 1 || !record.country_name || !record.registered_name) {
      return unavailable("record_not_ready");
    }

    return json({
      found: true,
      country: String(record.country_name),
      registeredName: String(record.registered_name),
    });
  } catch {
    // Never log the submitted ID, database row, or HMAC input.
    return unavailable("lookup_unavailable");
  }
}
