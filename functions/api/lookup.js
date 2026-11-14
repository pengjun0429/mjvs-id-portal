import { getLookupStatus, getRegistryState, normalizeId } from "../lib/registry.mjs";

const MESSAGE_EMPTY = "名錄尚未啟用（目前沒有任何 ID 記錄）。";
const MESSAGE_UNAVAILABLE = "名錄目前無法讀取，暫時不能確認 ID。";
const MESSAGE_INVALID = "名錄格式無法確認，暫時不能查驗。";
const MESSAGE_NOT_LISTED = "沒有在免簽名單之內";
const MAX_BODY_LENGTH = 2048;

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

function unavailable(state) {
  const message = state === "empty" ? MESSAGE_EMPTY : state === "invalid" ? MESSAGE_INVALID : MESSAGE_UNAVAILABLE;
  const error = state === "empty" ? "registry_not_ready" : state === "invalid" ? "registry_invalid" : "registry_unavailable";
  return json({ error, message }, 503);
}

export async function onRequest({ request }) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { Allow: "POST" });

  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "origin_not_allowed" }, 403);
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

  try {
    const registry = await getRegistryState();
    if (!registry.ready) return unavailable(registry.state);
    const status = getLookupStatus(registry, id);
    if (status !== "active") return json({ valid: false, message: MESSAGE_NOT_LISTED });
    return json({
      valid: true,
      message: "此 ID 有效；實際免簽待遇仍須依目的地與個別生效互惠協議確認。",
    });
  } catch {
    return unavailable("unavailable");
  }
}
