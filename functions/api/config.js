import { getRegistryState } from "../lib/registry.mjs";

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

function messageFor(state) {
  if (state === "ready") return "名錄已啟用，可以查驗單筆 ID。";
  if (state === "empty") return "名錄尚未啟用（目前沒有任何 ID 記錄）。";
  if (state === "invalid") return "名錄格式無法確認，暫時不能查驗。";
  return "名錄目前無法讀取，暫時不能確認 ID。";
}

export async function onRequest({ request }) {
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  try {
    const registry = await getRegistryState();
    return json({ lookupEnabled: registry.ready, status: registry.state, message: messageFor(registry.state) });
  } catch {
    return json({ lookupEnabled: false, status: "unavailable", message: messageFor("unavailable") });
  }
}
