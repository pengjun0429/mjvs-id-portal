const PUBLIC_CSV_URL = "https://docs.google.com/spreadsheets/d/1A6Pcriu-xDtgUSM0oPHx362QApUg_-KkSmCmK_FUVFU/gviz/tq?tqx=out:csv&gid=1037470539&tq=select%20A%2CB%2CC";
const MAX_CSV_BYTES = 2_000_000;
const MAX_REGISTRY_ROWS = 5000;
const MAX_COUNTRY_NAME_LENGTH = 120;
const VALID_STATUSES = new Set(["active", "suspended", "revoked"]);
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

export function normalizeId(value) {
  if (typeof value !== "string") return null;
  const id = value.normalize("NFKC").trim().toUpperCase();
  if (!id || id.length > 128 || CONTROL_CHARS.test(id)) return null;
  return id;
}

async function fetchLimitedCsv() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(PUBLIC_CSV_URL, {
      method: "GET",
      headers: { Accept: "text/csv" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok || !/text\/csv/i.test(response.headers.get("Content-Type") || "")) return null;
    const contentLength = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_CSV_BYTES) return null;
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_CSV_BYTES) return null;
    return text;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
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

export async function getRegistryState() {
  const csvText = await fetchLimitedCsv();
  if (csvText === null) return { ready: false, state: "unavailable", records: null };

  const rows = parseCsv(csvText);
  if (!rows?.length) return { ready: false, state: "invalid", records: null };
  const headers = rows[0].map((value) => value.trim());
  if (headers.length !== 3 || headers[0] !== "id" || headers[1] !== "country_name" || headers[2] !== "status") {
    return { ready: false, state: "invalid", records: null };
  }

  const dataRows = rows.slice(1).filter((record) => record.some((cell) => cell.trim() !== ""));
  if (dataRows.length === 0) return { ready: false, state: "empty", records: null };
  if (dataRows.length > MAX_REGISTRY_ROWS) return { ready: false, state: "invalid", records: null };

  const records = new Map();
  for (const row of dataRows) {
    if (row.length !== 3) return { ready: false, state: "invalid", records: null };
    const id = normalizeId(row[0]);
    const country = row[1].trim();
    const status = row[2].trim().toLowerCase();
    if (
      !id ||
      !country ||
      country.length > MAX_COUNTRY_NAME_LENGTH ||
      CONTROL_CHARS.test(country) ||
      !VALID_STATUSES.has(status) ||
      records.has(id)
    ) {
      return { ready: false, state: "invalid", records: null };
    }
    records.set(id, { country, status });
  }

  return { ready: true, state: "ready", records };
}

export function getLookupRecord(registry, id) {
  if (!registry?.ready || !(registry.records instanceof Map)) return null;
  return registry.records.get(id) ?? null;
}
