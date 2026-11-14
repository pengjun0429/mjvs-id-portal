import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../rate-limiter/src/index.js", import.meta.url), "utf8");
const { LookupLimiter, default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

let now = 1_000_000;
const originalNow = Date.now;
Date.now = () => now;
const values = new Map();
let alarmAt = 0;
const state = {
  storage: {
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, value); },
    async delete(key) { return values.delete(key); },
    async setAlarm(value) { alarmAt = value; },
  },
  async blockConcurrencyWhile(callback) { return callback(); },
};

try {
  const limiter = new LookupLimiter(state);
  for (let i = 0; i < 10; i += 1) {
    const response = await limiter.fetch(new Request("https://mjvs-limiter.internal/check", { method: "POST" }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { allowed: true });
  }

  const blocked = await limiter.fetch(new Request("https://mjvs-limiter.internal/check", { method: "POST" }));
  assert.equal(blocked.status, 429);
  const blockedBody = await blocked.json();
  assert.equal(blockedBody.allowed, false);
  assert.ok(blockedBody.retryAfter > 0 && blockedBody.retryAfter <= 60);
  assert.equal(alarmAt, now + 60_000);

  now += 60_001;
  await limiter.alarm();
  assert.equal(await state.storage.get("bucket"), undefined);
  const afterWindow = await limiter.fetch(new Request("https://mjvs-limiter.internal/check", { method: "POST" }));
  assert.equal(afterWindow.status, 200);

  const notPublic = await worker.fetch(new Request("https://rate-limiter.example/"));
  assert.equal(notPublic.status, 404);
  const wrongPath = await limiter.fetch(new Request("https://mjvs-limiter.internal/other", { method: "POST" }));
  assert.equal(wrongPath.status, 404);

  console.log("MJVS rate-limiter tests passed.");
} finally {
  Date.now = originalNow;
}
