import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const helperSource = await readFile(new URL("../functions/lib/registry.mjs", import.meta.url), "utf8");
const helper = await import(`data:text/javascript;base64,${Buffer.from(helperSource).toString("base64")}`);
globalThis.__MJVS_REGISTRY_HELPER__ = helper;

const lookupImport = 'import { getLookupStatus, getRegistryState, normalizeId } from "../lib/registry.mjs";';
const configImport = 'import { getRegistryState } from "../lib/registry.mjs";';
const lookupSource = (await readFile(new URL("../functions/api/lookup.js", import.meta.url), "utf8"))
  .replace(lookupImport, "const { getLookupStatus, getRegistryState, normalizeId } = globalThis.__MJVS_REGISTRY_HELPER__;");
const configSource = (await readFile(new URL("../functions/api/config.js", import.meta.url), "utf8"))
  .replace(configImport, "const { getRegistryState } = globalThis.__MJVS_REGISTRY_HELPER__;");
assert.doesNotMatch(lookupSource, /^import /m);
assert.doesNotMatch(configSource, /^import /m);
const { onRequest } = await import(`data:text/javascript;base64,${Buffer.from(lookupSource).toString("base64")}`);
const { onRequest: onConfigRequest } = await import(`data:text/javascript;base64,${Buffer.from(configSource).toString("base64")}`);

const REGISTRY_CSV_URL_PATH = "/spreadsheets/d/1A6Pcriu-xDtgUSM0oPHx362QApUg_-KkSmCmK_FUVFU/gviz/tq";
const validHeaders = "id,status";
let registryCsv = `${validHeaders}\n`;
let csvResponseOk = true;
let csvContentType = "text/csv; charset=utf-8";
let csvCalls = 0;

function makeRequest({ method = "POST", body = { id: "TEST-ONLY-ID-0000000000000001" }, contentType = "application/json", origin = "https://mjvs.test" } = {}) {
  const headers = new Headers({ "Content-Type": contentType });
  if (origin) headers.set("Origin", origin);
  return new Request("https://mjvs.test/api/lookup", {
    method,
    headers,
    body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (resource, options = {}) => {
  const url = new URL(String(resource));
  assert.equal(url.hostname, "docs.google.com");
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
};

try {
  const emptyConfigResponse = await onConfigRequest({ request: new Request("https://mjvs.test/api/config"), env: {} });
  assert.equal(emptyConfigResponse.status, 200);
  assert.deepEqual(await emptyConfigResponse.json(), {
    lookupEnabled: false,
    status: "empty",
    message: "名錄尚未啟用（目前沒有任何 ID 記錄）。",
  });

  const emptyLookup = await onRequest({ request: makeRequest(), env: {} });
  assert.equal(emptyLookup.status, 503);
  assert.deepEqual(await emptyLookup.json(), {
    error: "registry_not_ready",
    message: "名錄尚未啟用（目前沒有任何 ID 記錄）。",
  });

  const wrongMethod = await onRequest({ request: makeRequest({ method: "GET" }), env: {} });
  assert.equal(wrongMethod.status, 405);

  const wrongOrigin = await onRequest({ request: makeRequest({ origin: "https://attacker.example" }), env: {} });
  assert.equal(wrongOrigin.status, 403);

  const wrongContentType = await onRequest({ request: makeRequest({ contentType: "text/plain", body: "id" }), env: {} });
  assert.equal(wrongContentType.status, 415);

  const invalidJson = await onRequest({ request: makeRequest({ body: "{invalid" }), env: {} });
  assert.equal(invalidJson.status, 400);

  const invalidId = await onRequest({ request: makeRequest({ body: { id: "   " } }), env: {} });
  assert.equal(invalidId.status, 400);

  registryCsv = `${validHeaders}\nTEST-ONLY-ID-0000000000000001,active\n`;
  const readyConfig = await onConfigRequest({ request: new Request("https://mjvs.test/api/config"), env: {} });
  assert.deepEqual(await readyConfig.json(), {
    lookupEnabled: true,
    status: "ready",
    message: "名錄已啟用，可以查驗單筆 ID。",
  });

  const valid = await onRequest({ request: makeRequest(), env: {} });
  assert.equal(valid.status, 200);
  const validBody = await valid.json();
  assert.equal(validBody.valid, true);
  assert.equal(validBody.message, "此 ID 有效。");
  assert.equal(JSON.stringify(validBody).includes("TEST-ONLY-ID"), false);
  assert.deepEqual(Object.keys(validBody).sort(), ["message", "valid"]);
  assert.equal("name" in validBody, false);
  assert.equal("country" in validBody, false);

  const unknown = await onRequest({
    request: makeRequest({ body: { id: "TEST-ONLY-UNKNOWN-0000000000000001" } }),
    env: {},
  });
  assert.deepEqual(await unknown.json(), { valid: false, message: "沒有在免簽名單之內" });

  registryCsv = `${validHeaders}\nTEST-ONLY-ID-0000000000000001,suspended\n`;
  const suspended = await onRequest({ request: makeRequest(), env: {} });
  assert.deepEqual(await suspended.json(), { valid: false, message: "沒有在免簽名單之內" });

  registryCsv = `${validHeaders}\nTEST-ONLY-ID-0000000000000001,revoked\n`;
  const revoked = await onRequest({ request: makeRequest(), env: {} });
  assert.deepEqual(await revoked.json(), { valid: false, message: "沒有在免簽名單之內" });

  registryCsv = "id,wrong_status\nTEST-ONLY-ID-0000000000000001,active\n";
  const invalidConfig = await onConfigRequest({ request: new Request("https://mjvs.test/api/config"), env: {} });
  assert.equal((await invalidConfig.json()).status, "invalid");
  assert.equal((await onRequest({ request: makeRequest(), env: {} })).status, 503);

  registryCsv = `${validHeaders}\nTEST-ONLY-ID-0000000000000001,active\nTEST-ONLY-ID-0000000000000001,active\n`;
  assert.equal((await onRequest({ request: makeRequest(), env: {} })).status, 503);

  csvResponseOk = false;
  const upstreamConfig = await onConfigRequest({ request: new Request("https://mjvs.test/api/config"), env: {} });
  assert.equal((await upstreamConfig.json()).status, "unavailable");
  assert.equal((await onRequest({ request: makeRequest(), env: {} })).status, 503);
  csvResponseOk = true;

  csvContentType = "text/html; charset=utf-8";
  assert.equal((await onRequest({ request: makeRequest(), env: {} })).status, 503);
  csvContentType = "text/csv; charset=utf-8";

  const page = await readFile(new URL("../site/index.html", import.meta.url), "utf8");
  const frontend = await readFile(new URL("../site/app.js", import.meta.url), "utf8");
  assert.match(page, /知道試算表連結的人可以查看整份表格/);
  assert.match(page, /ID 有效性查驗/);
  assert.match(page, /discord\.gg\/upPuxDWxUT/);
  assert.match(page, /沒有在免簽名單之內/);
  assert.doesNotMatch(page + frontend, /互惠|申請流程|申請準備|參與方申請|兩種 ID|個案審查/);
  assert.doesNotMatch(page + frontend, /turnstile|captcha|rate.?limit|防刷|限流/i);
  assert.doesNotMatch(frontend, /registeredName|registered_name|\.country/);
  assert.ok(csvCalls > 0);
  console.log("MJVS lookup tests passed: empty registry is not reported as not-listed; valid/unknown IDs work when rows exist.");
} finally {
  globalThis.fetch = originalFetch;
  delete globalThis.__MJVS_REGISTRY_HELPER__;
}
