import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

globalThis.crypto ??= webcrypto;
const lookupSource = await readFile(new URL("../functions/api/lookup.js", import.meta.url), "utf8");
const configSource = await readFile(new URL("../functions/api/config.js", import.meta.url), "utf8");
const { onRequest } = await import(`data:text/javascript;base64,${Buffer.from(lookupSource).toString("base64")}`);
const { onRequest: onConfigRequest } = await import(`data:text/javascript;base64,${Buffer.from(configSource).toString("base64")}`);

const generated = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", generated.privateKey));
const pemBody = Buffer.from(pkcs8).toString("base64").match(/.{1,64}/g).join("\n");
const testServiceAccount = JSON.stringify({
  client_email: "mjvs-test-only@example.iam.gserviceaccount.com",
  private_key: `-----BEGIN PRIVATE KEY-----\n${pemBody}\n-----END PRIVATE KEY-----\n`,
});

const headers = [
  { range: "'名錄'!A1:A5002", values: [["id"], ["TEST-ONLY-ID-0000000000000001"]] },
  { range: "'名錄'!E1:E5002", values: [["status"], ["active"]] },
];
let sheetFixture = headers;
let siteverifyResult = { success: true, hostname: "mjvs.test", action: "mjvs_lookup" };
let sheetResponseOk = true;
let fetchedRanges = [];
let googleCalls = 0;

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
  MJVS_SPREADSHEET_ID: "test-only-sheet-id",
  MJVS_GOOGLE_SERVICE_ACCOUNT_JSON: testServiceAccount,
  TURNSTILE_SITE_KEY: "test-only-public-site-key",
  TURNSTILE_SECRET_KEY: "test-only-turnstile-secret",
  LOOKUP_RATE_LIMIT_PEPPER: "test-only-random-pepper",
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
  if (url.hostname === "oauth2.googleapis.com") {
    googleCalls += 1;
    const form = new URLSearchParams(options.body);
    assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
    assert.ok(form.get("assertion"));
    return jsonResponse({ access_token: "test-only-google-access-token", expires_in: 3600 }, 200);
  }
  if (url.hostname === "sheets.googleapis.com") {
    googleCalls += 1;
    assert.match(url.pathname, /\/values:batchGet$/);
    assert.equal(options.headers.Authorization, "Bearer test-only-google-access-token");
    fetchedRanges = url.searchParams.getAll("ranges");
    return jsonResponse(sheetResponseOk ? { valueRanges: sheetFixture } : { error: "upstream failure" }, sheetResponseOk ? 200 : 503);
  }
  throw new Error(`Unexpected test fetch host: ${url.hostname}`);
};

try {
  const noConfig = await onConfigRequest({ request: new Request("https://mjvs.test/api/config"), env: {} });
  assert.equal(noConfig.status, 200);
  assert.deepEqual(await noConfig.json(), { lookupEnabled: false, turnstileSiteKey: null });

  const configured = await onConfigRequest({ request: new Request("https://mjvs.test/api/config"), env: baseEnv() });
  assert.deepEqual(await configured.json(), { lookupEnabled: true, turnstileSiteKey: "test-only-public-site-key" });

  const missingPrivateSetup = await onRequest({ request: makeRequest(), env: {} });
  assert.equal(missingPrivateSetup.status, 503);
  assert.equal((await missingPrivateSetup.json()).error, "registry_not_ready");

  const noLimiter = baseEnv();
  delete noLimiter.LOOKUP_RATE_LIMITER;
  const noLimiterResponse = await onRequest({ request: makeRequest(), env: noLimiter });
  assert.equal(noLimiterResponse.status, 503);

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

  siteverifyResult = { success: false, hostname: "mjvs.test", action: "mjvs_lookup" };
  const invalidCaptcha = await onRequest({ request: makeRequest(), env: baseEnv() });
  assert.equal(invalidCaptcha.status, 403);
  const googleCallsBeforeValidCaptcha = googleCalls;
  siteverifyResult = { success: true, hostname: "other.test", action: "mjvs_lookup" };
  const wrongHostname = await onRequest({ request: makeRequest(), env: baseEnv() });
  assert.equal(wrongHostname.status, 403);
  assert.equal(googleCalls, googleCallsBeforeValidCaptcha);
  siteverifyResult = { success: true, hostname: "mjvs.test", action: "mjvs_lookup" };

  sheetFixture = [
    { range: "'名錄'!A1:A5002", values: [["id"]] },
    { range: "'名錄'!E1:E5002", values: [["status"]] },
  ];
  const emptyRegistry = await onRequest({ request: makeRequest(), env: baseEnv() });
  assert.equal(emptyRegistry.status, 503);
  assert.equal((await emptyRegistry.json()).error, "registry_not_ready");

  sheetFixture = headers;
  const valid = await onRequest({ request: makeRequest(), env: baseEnv() });
  assert.equal(valid.status, 200);
  const validBody = await valid.json();
  assert.equal(validBody.valid, true);
  assert.equal(JSON.stringify(validBody).includes("TEST-ONLY-ID"), false);
  assert.equal("name" in validBody, false);
  assert.equal("country" in validBody, false);
  assert.deepEqual(fetchedRanges, ["'名錄'!A1:A5002", "'名錄'!E1:E5002"]);

  const unknown = await onRequest({
    request: makeRequest({ body: { id: "TEST-ONLY-UNKNOWN-0000000000000001", captchaToken: "test-only-token" } }),
    env: baseEnv(),
  });
  assert.deepEqual(await unknown.json(), { valid: false, message: "沒有在免簽名單之內" });

  sheetFixture = [
    { range: "'名錄'!A1:A5002", values: [["id"], ["TEST-ONLY-ID-0000000000000001"]] },
    { range: "'名錄'!E1:E5002", values: [["status"], ["suspended"]] },
  ];
  const suspended = await onRequest({ request: makeRequest(), env: baseEnv() });
  assert.deepEqual(await suspended.json(), { valid: false, message: "沒有在免簽名單之內" });

  sheetFixture = [
    { range: "'名錄'!A1:A5002", values: [["id"], ["TEST-ONLY-ID-0000000000000001"]] },
    { range: "'名錄'!E1:E5002", values: [["wrong-header"], ["active"]] },
  ];
  const malformedRegistry = await onRequest({ request: makeRequest(), env: baseEnv() });
  assert.equal(malformedRegistry.status, 503);

  sheetFixture = headers;
  const missingIp = await onRequest({ request: makeRequest({ includeIp: false }), env: baseEnv() });
  assert.equal(missingIp.status, 503);

  sheetResponseOk = false;
  const upstreamFailure = await onRequest({ request: makeRequest(), env: baseEnv() });
  assert.equal(upstreamFailure.status, 503);
  sheetResponseOk = true;

  const lookupPage = await readFile(new URL("../site/index.html", import.meta.url), "utf8");
  const frontend = await readFile(new URL("../site/app.js", import.meta.url), "utf8");
  assert.match(lookupPage, /沒有在免簽名單之內/);
  assert.doesNotMatch(lookupPage, /registeredName|registered_name|個人姓名/);
  assert.doesNotMatch(frontend, /registeredName|registered_name|\.country/);

  console.log("MJVS ID-only lookup tests passed (no real IDs, names, or countries used).");
} finally {
  globalThis.fetch = originalFetch;
}
