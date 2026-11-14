import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

globalThis.crypto ??= webcrypto;
const lookupSource = await readFile(new URL("../functions/api/lookup.js", import.meta.url), "utf8");
const configSource = await readFile(new URL("../functions/api/config.js", import.meta.url), "utf8");
const { onRequest } = await import(`data:text/javascript;base64,${Buffer.from(lookupSource).toString("base64")}`);
const { onRequest: onConfigRequest } = await import(`data:text/javascript;base64,${Buffer.from(configSource).toString("base64")}`);

const REGISTRY_CSV_URL_PATH = "/spreadsheets/d/1A6Pcriu-xDtgUSM0oPHx362QApUg_-KkSmCmK_FUVFU/gviz/tq";
const validHeaders = "id,status";
let registryCsv = `${validHeaders}\nTEST-ONLY-ID-0000000000000001,active\n`;
let csvResponseOk = true;
let csvContentType = "text/csv; charset=utf-8";
let siteverifyResult = { success: true, hostname: "mjvs.test", action: "mjvs_lookup" };
let csvCalls = 0;

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

function mockLimiter({ allowed = true } = {}) {
  return {
    idFromName(name) {
      assert.match(name, /^[a-f0-9]{64}$/);
      return name;
    },
    get() {
      return {
        async fetch(url, init) {
          assert.equal(new URL(url).pathname, "/check");
          assert.equal(init.method, "POST");
          return jsonResponse(allowed ? { allowed: true } : { allowed: false, retryAfter: 30 }, allowed ? 200 : 429);
        },
      };
    },
  };
}

const baseEnv = () => ({
  MJVS_PUBLIC_LOOKUP_ENABLED: "true",
  TURNSTILE_SITE_KEY: "test-only-public-site-key",
  TURNSTILE_SECRET_KEY: "test-only-turnstile-secret",
  LOOKUP_RATE_LIMIT_PEPPER: "test-only-pepper-0123456789-32plus",
  LOOKUP_RATE_LIMITER: mockLimiter(),
});

function makeRequest({ method = "POST", body = { id: "TEST-ONLY-ID-0000000000000001", captchaToken: "test-only-token" }, contentType = "application/json", origin = "https://mjvs.test", includeIp = true } = {}) {
  const requestHeaders = new Headers({ "Content-Type": contentType });
  if (origin) requestHeaders.set("Origin", origin);
  if (includeIp) requestHeaders.set("CF-Connecting-IP", "203.0.113.7");
  return new Request("https://mjvs.test/api/lookup", {
    method,
    headers: requestHeaders,
    body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (resource, options = {}) => {
  const url = new URL(String(resource));
  if (url.hostname === "challenges.cloudflare.com") {
    const body = JSON.parse(options.body);
    if (body.secret !== "test-only-turnstile-secret" || body.response !== "test-only-token") {
      return jsonResponse({ success: false }, 200);
    }
    return jsonResponse(siteverifyResult, 200);
  }
  if (url.hostname === "docs.google.com") {
    csvCalls += 1;
    assert.equal(url.pathname, REGISTRY_CSV_URL_PATH);
    assert.equal(url.searchParams.get("tqx"), "out:csv");
    assert.equal(url.searchParams.get("gid"), "1037470539");
    assert.equal(url.searchParams.get("tq"), "select A,E");
    assert.equal(options.method, "GET");
    assert.equal(options.headers.Accept, "text/csv");
    return new Response(csvResponseOk ? registryCsv : "upstream unavailable", {
      status: csvResponseOk ? 200 : 503,
      headers: { "Content-Type": csvContentType },
    });
  }
  throw new Error(`Unexpected test fetch host: ${url.hostname}`);
};

try {
  const noConfig = await onConfigRequest({ request: new Request("https://mjvs.test/api/config"), env: {} });
  assert.equal(noConfig.status, 200);
  assert.deepEqual(await noConfig.json(), { lookupEnabled: false, turnstileSiteKey: null });

  const configured = await onConfigRequest({ request: new Request("https://mjvs.test/api/config"), env: baseEnv() });
  assert.deepEqual(await configured.json(), { lookupEnabled: true, turnstileSiteKey: "test-only-public-site-key" });

  const unavailableConfig = await onRequest({ request: makeRequest(), env: {} });
  assert.equal(unavailableConfig.status, 503);
  assert.equal((await unavailableConfig.json()).error, "registry_not_ready");

  const noLimiter = baseEnv();
  delete noLimiter.LOOKUP_RATE_LIMITER;
  const noLimiterResponse = await onRequest({ request: makeRequest(), env: noLimiter });
  assert.equal(noLimiterResponse.status, 503);

  const shortPepper = { ...baseEnv(), LOOKUP_RATE_LIMIT_PEPPER: "too-short" };
  assert.equal((await onRequest({ request: makeRequest(), env: shortPepper })).status, 503);

  const wrongMethod = await onRequest({ request: makeRequest({ method: "GET" }), env: baseEnv() });
  assert.equal(wrongMethod.status, 405);

  const wrongOrigin = await onRequest({ request: makeRequest({ origin: "https://attacker.example" }), env: baseEnv() });
  assert.equal(wrongOrigin.status, 403);

  const rateLimited = await onRequest({
    request: makeRequest(),
    env: { ...baseEnv(), LOOKUP_RATE_LIMITER: mockLimiter({ allowed: false }) },
  });
  assert.equal(rateLimited.status, 429);
  assert.equal(rateLimited.headers.get("Retry-After"), "30");

  const csvCallsBeforeCaptcha = csvCalls;
  siteverifyResult = { success: false, hostname: "mjvs.test", action: "mjvs_lookup" };
  const invalidCaptcha = await onRequest({ request: makeRequest(), env: baseEnv() });
  assert.equal(invalidCaptcha.status, 403);
  assert.equal(csvCalls, csvCallsBeforeCaptcha);

  siteverifyResult = { success: true, hostname: "other.test", action: "mjvs_lookup" };
  const wrongHostname = await onRequest({ request: makeRequest(), env: baseEnv() });
  assert.equal(wrongHostname.status, 403);
  siteverifyResult = { success: true, hostname: "mjvs.test", action: "mjvs_lookup" };

  registryCsv = `${validHeaders}\n`;
  const emptyRegistry = await onRequest({ request: makeRequest(), env: baseEnv() });
  assert.equal(emptyRegistry.status, 503);
  assert.equal((await emptyRegistry.json()).error, "registry_not_ready");

  registryCsv = `${validHeaders}\n\n`;
  const onlyBlankRows = await onRequest({ request: makeRequest(), env: baseEnv() });
  assert.equal(onlyBlankRows.status, 503);

  registryCsv = `${validHeaders}\r\nTEST-ONLY-ID-0000000000000001,active\r\n`;
  const valid = await onRequest({ request: makeRequest(), env: baseEnv() });
  assert.equal(valid.status, 200);
  const validBody = await valid.json();
  assert.equal(validBody.valid, true);
  assert.equal(JSON.stringify(validBody).includes("TEST-ONLY-ID"), false);
  assert.deepEqual(Object.keys(validBody).sort(), ["message", "valid"]);
  assert.equal("name" in validBody, false);
  assert.equal("country" in validBody, false);

  const unknown = await onRequest({
    request: makeRequest({ body: { id: "TEST-ONLY-UNKNOWN-0000000000000001", captchaToken: "test-only-token" } }),
    env: baseEnv(),
  });
  assert.deepEqual(await unknown.json(), { valid: false, message: "沒有在免簽名單之內" });

  registryCsv = `${validHeaders}\nTEST-ONLY-ID-0000000000000001,suspended\n`;
  const suspended = await onRequest({ request: makeRequest(), env: baseEnv() });
  assert.deepEqual(await suspended.json(), { valid: false, message: "沒有在免簽名單之內" });

  registryCsv = "id,wrong_status\nTEST-ONLY-ID-0000000000000001,active\n";
  assert.equal((await onRequest({ request: makeRequest(), env: baseEnv() })).status, 503);

  registryCsv = `${validHeaders}\nTEST-ONLY-ID-0000000000000001,active\nTEST-ONLY-ID-0000000000000001,active\n`;
  assert.equal((await onRequest({ request: makeRequest(), env: baseEnv() })).status, 503);

  registryCsv = `${validHeaders}\nTEST-ONLY-ID-0000000000000001,active\n`;
  const missingIp = await onRequest({ request: makeRequest({ includeIp: false }), env: baseEnv() });
  assert.equal(missingIp.status, 503);

  csvResponseOk = false;
  const upstreamFailure = await onRequest({ request: makeRequest(), env: baseEnv() });
  assert.equal(upstreamFailure.status, 503);
  csvResponseOk = true;

  csvContentType = "text/html; charset=utf-8";
  const htmlInsteadOfCsv = await onRequest({ request: makeRequest(), env: baseEnv() });
  assert.equal(htmlInsteadOfCsv.status, 503);
  csvContentType = "text/csv; charset=utf-8";

  const lookupPage = await readFile(new URL("../site/index.html", import.meta.url), "utf8");
  const frontend = await readFile(new URL("../site/app.js", import.meta.url), "utf8");
  assert.match(lookupPage, /任何取得試算表連結的人都能檢視整份表格/);
  assert.match(lookupPage, /沒有在免簽名單之內/);
  assert.doesNotMatch(frontend, /registeredName|registered_name|\.country/);

  console.log("MJVS two-column public-CSV ID/status lookup tests passed (no real IDs, names, or countries used).");
} finally {
  globalThis.fetch = originalFetch;
}
