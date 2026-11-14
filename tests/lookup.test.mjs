import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

globalThis.crypto ??= webcrypto;
const source = await readFile(new URL("../functions/api/lookup.js", import.meta.url), "utf8");
const { onRequest } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

function makeRequest({ method = "POST", body = { id: "MJVS-EXAMPLE-001" }, contentType = "application/json", origin } = {}) {
  const headers = new Headers({ "Content-Type": contentType });
  if (origin) headers.set("Origin", origin);
  return new Request("https://mjvs.test/api/lookup", {
    method,
    headers,
    body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

function makeDb({ ready = 1, record = null } = {}) {
  return {
    prepare(sql) {
      return {
        bind() { return this; },
        async first() {
          if (sql.includes("registry_control")) return { is_ready: ready };
          if (sql.includes("FROM issued_ids")) return record;
          return null;
        },
      };
    },
  };
}

const withoutDatabase = await onRequest({
  request: makeRequest({ body: "not-json" }),
  env: {},
});
assert.equal(withoutDatabase.status, 503);
assert.equal((await withoutDatabase.json()).error, "registry_not_ready");

const inactiveRegistry = await onRequest({
  request: makeRequest(),
  env: { DB: makeDb({ ready: 0 }), ID_LOOKUP_PEPPER: "test-only-pepper" },
});
assert.equal(inactiveRegistry.status, 503);
assert.equal((await inactiveRegistry.json()).error, "registry_not_ready");

const noMatch = await onRequest({
  request: makeRequest(),
  env: { DB: makeDb({ record: null }), ID_LOOKUP_PEPPER: "test-only-pepper" },
});
assert.equal(noMatch.status, 200);
assert.deepEqual(await noMatch.json(), { found: false, message: "沒有在免簽名單之內" });

const found = await onRequest({
  request: makeRequest(),
  env: {
    DB: makeDb({ record: { country_name: "示範參與方（虛構）", registered_name: "示範姓名（虛構）", public_name_authorized: 1 } }),
    ID_LOOKUP_PEPPER: "test-only-pepper",
  },
});
assert.equal(found.status, 200);
const foundData = await found.json();
assert.deepEqual(foundData, { found: true, country: "示範參與方（虛構）", registeredName: "示範姓名（虛構）" });
assert.equal(JSON.stringify(foundData).includes("MJVS-EXAMPLE-001"), false);

const privateName = await onRequest({
  request: makeRequest(),
  env: {
    DB: makeDb({ record: { country_name: "示範參與方（虛構）", registered_name: "示範姓名（虛構）", public_name_authorized: 0 } }),
    ID_LOOKUP_PEPPER: "test-only-pepper",
  },
});
assert.equal(privateName.status, 503);
assert.equal((await privateName.json()).error, "record_not_ready");

const wrongOrigin = await onRequest({
  request: makeRequest({ origin: "https://attacker.example" }),
  env: { DB: makeDb(), ID_LOOKUP_PEPPER: "test-only-pepper" },
});
assert.equal(wrongOrigin.status, 403);

const wrongMethod = await onRequest({ request: makeRequest({ method: "GET" }), env: {} });
assert.equal(wrongMethod.status, 405);

console.log("MJVS lookup smoke tests passed (no real IDs or personal data used).");
