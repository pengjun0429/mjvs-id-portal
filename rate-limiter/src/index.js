const WINDOW_MS = 60_000;
const REQUEST_LIMIT = 10;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export class LookupLimiter {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/check") {
      return new Response("Not found", { status: 404 });
    }

    const now = Date.now();
    const result = await this.state.blockConcurrencyWhile(async () => {
      let bucket = await this.state.storage.get("bucket");
      if (!bucket || now - bucket.startedAt >= WINDOW_MS) {
        bucket = { startedAt: now, count: 0 };
      }
      if (bucket.count >= REQUEST_LIMIT) {
        return {
          allowed: false,
          retryAfter: Math.max(1, Math.ceil((bucket.startedAt + WINDOW_MS - now) / 1000)),
          startedAt: bucket.startedAt,
        };
      }
      bucket.count += 1;
      await this.state.storage.put("bucket", bucket);
      await this.state.storage.setAlarm(bucket.startedAt + WINDOW_MS);
      return { allowed: true, startedAt: bucket.startedAt };
    });

    if (!result.allowed) return json({ allowed: false, retryAfter: result.retryAfter }, 429);
    return json({ allowed: true });
  }

  async alarm() {
    await this.state.storage.delete("bucket");
  }
}

export default {
  async fetch() {
    // The Worker has no public API; the Durable Object is called only by an authorized Pages binding.
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  },
};
