"use strict";

/**
 * Node-native text-format writers — the small, dependency-light document
 * generators that the pipeline registry advertises but that previously had
 * no implementation wired into `getLocalProviders()`. Each one mirrors the
 * existing generator contract:
 *
 *     fn(plan) -> { buffer: Buffer, mime: string, extension: string }
 *
 * Covered formats (registry generator id -> format):
 *   text-writer    -> txt     (text/plain)
 *   json-writer    -> json    (application/json)
 *   csv-writer     -> csv     (text/csv, RFC-4180 quoting)
 *   tsv-writer     -> tsv     (text/tab-separated-values)
 *   yaml-writer    -> yaml    (application/yaml, via js-yaml)
 *   xml-writer     -> xml     (application/xml)
 *   ndjson-writer  -> ndjson  (application/x-ndjson)
 *   ics-writer     -> ics     (text/calendar, RFC 5545 VEVENT)
 *   vcf-writer     -> vcf     (text/vcard, RFC 6350 vCard 3.0)
 *   bibtex-writer  -> bib     (application/x-bibtex)
 *
 * All writers are pure and deterministic given their input. The only
 * exception is the ICS `DTSTAMP`, which falls back to the current time
 * when the caller does not pin `plan.dtstamp` — pass it for reproducible
 * output (the test-suite does).
 */

const yaml = require("js-yaml");

function buf(text, mime, extension) {
  return { buffer: Buffer.from(String(text), "utf8"), mime, extension };
}

// Pull the "main payload" out of a plan, tolerating both the rich
// `{ data }`/`{ body }` envelope and a bare string/value.
function payloadString(plan, keys = ["text", "body", "content", "markdown"]) {
  if (typeof plan === "string") return plan;
  if (plan == null || typeof plan !== "object") return String(plan ?? "");
  for (const k of keys) {
    if (plan[k] != null) return String(plan[k]);
  }
  return "";
}

function structuredPayload(plan) {
  if (plan && typeof plan === "object" && !Array.isArray(plan) && "data" in plan) {
    return plan.data;
  }
  return plan;
}

// ── txt ─────────────────────────────────────────────────────────────────
function generateText(plan) {
  return buf(payloadString(plan), "text/plain", "txt");
}

// ── json ────────────────────────────────────────────────────────────────
function generateJson(plan) {
  // A bare string is treated as pre-serialised JSON and passed through.
  if (typeof plan === "string") return buf(plan, "application/json", "json");
  const data = structuredPayload(plan);
  const indent = plan && typeof plan === "object" && Number.isInteger(plan.indent) ? plan.indent : 2;
  return buf(JSON.stringify(data ?? null, null, indent) + "\n", "application/json", "json");
}

// ── csv / tsv (shared tabular core) ───────────────────────────────────────
// Coerce a plan into { headers, rows } where rows is an array of string[].
function tabularize(plan) {
  if (Array.isArray(plan)) return rowsFromValue(plan, null);
  const headers = Array.isArray(plan && plan.headers)
    ? plan.headers.map(String)
    : Array.isArray(plan && plan.columns)
      ? plan.columns.map(String)
      : null;
  if (Array.isArray(plan && plan.rows)) {
    return { headers, rows: plan.rows.map((r) => (Array.isArray(r) ? r.map(cell) : [cell(r)])) };
  }
  if (Array.isArray(plan && plan.records)) {
    return rowsFromValue(plan.records, headers);
  }
  return { headers, rows: [] };
}

function rowsFromValue(records, headers) {
  if (!Array.isArray(records) || records.length === 0) return { headers: headers || [], rows: [] };
  // Array of arrays → already tabular.
  if (records.every((r) => Array.isArray(r))) {
    return { headers, rows: records.map((r) => r.map(cell)) };
  }
  // Array of objects → derive a stable header union (first-seen order).
  const cols = headers ? [...headers] : [];
  if (!headers) {
    const seen = new Set();
    for (const rec of records) {
      if (rec && typeof rec === "object") {
        for (const k of Object.keys(rec)) {
          if (!seen.has(k)) {
            seen.add(k);
            cols.push(k);
          }
        }
      }
    }
  }
  const rows = records.map((rec) => cols.map((c) => cell(rec && typeof rec === "object" ? rec[c] : rec)));
  return { headers: cols, rows };
}

function cell(v) {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function csvField(s) {
  // RFC-4180: quote when the field holds a comma, quote, CR or LF; escape
  // embedded quotes by doubling.
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function generateCsv(plan) {
  const { headers, rows } = tabularize(plan);
  const lines = [];
  if (headers && headers.length) lines.push(headers.map((h) => csvField(String(h))).join(","));
  for (const r of rows) lines.push(r.map((c) => csvField(c)).join(","));
  // RFC-4180 records are CRLF-terminated.
  return buf(lines.join("\r\n") + (lines.length ? "\r\n" : ""), "text/csv", "csv");
}

function generateTsv(plan) {
  const { headers, rows } = tabularize(plan);
  // TSV has no quoting convention; neutralise field separators/newlines.
  const clean = (s) => String(s).replace(/[\t\r\n]+/g, " ");
  const lines = [];
  if (headers && headers.length) lines.push(headers.map((h) => clean(h)).join("\t"));
  for (const r of rows) lines.push(r.map((c) => clean(c)).join("\t"));
  return buf(lines.join("\n") + (lines.length ? "\n" : ""), "text/tab-separated-values", "tsv");
}

// ── yaml ────────────────────────────────────────────────────────────────
function generateYaml(plan) {
  if (typeof plan === "string") return buf(plan, "application/yaml", "yaml");
  const data = structuredPayload(plan);
  const text = yaml.dump(data ?? null, { lineWidth: -1, noRefs: true, sortKeys: false });
  return buf(text, "application/yaml", "yaml");
}

// ── xml ─────────────────────────────────────────────────────────────────
function xmlEscape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Conservative XML element-name sanitiser; falls back to `item` for keys
// that aren't valid NCNames (e.g. those starting with a digit).
function xmlName(k) {
  const s = String(k).replace(/[^A-Za-z0-9_.-]/g, "_");
  return /^[A-Za-z_]/.test(s) ? s : `_${s}`;
}

function valueToXml(value, tag, indent) {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    return value.map((v) => valueToXml(v, tag, indent)).join("");
  }
  if (value && typeof value === "object") {
    const inner = Object.keys(value)
      .map((k) => valueToXml(value[k], xmlName(k), indent + 1))
      .join("");
    return `${pad}<${tag}>\n${inner}${pad}</${tag}>\n`;
  }
  if (value == null) return `${pad}<${tag}/>\n`;
  return `${pad}<${tag}>${xmlEscape(value)}</${tag}>\n`;
}

function generateXml(plan) {
  if (plan && typeof plan === "object" && typeof plan.xml === "string") {
    return buf(plan.xml, "application/xml", "xml");
  }
  const root = (plan && typeof plan === "object" && plan.root) || "root";
  const data = structuredPayload(plan);
  const body =
    data && typeof data === "object"
      ? Object.keys(data)
          .map((k) => valueToXml(data[k], xmlName(k), 1))
          .join("")
      : `  <value>${xmlEscape(data)}</value>\n`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<${xmlName(root)}>\n${body}</${xmlName(root)}>\n`;
  return buf(xml, "application/xml", "xml");
}

// ── ndjson ──────────────────────────────────────────────────────────────
function generateNdjson(plan) {
  let records;
  if (Array.isArray(plan)) records = plan;
  else if (plan && Array.isArray(plan.records)) records = plan.records;
  else if (plan && Array.isArray(plan.rows)) records = plan.rows;
  else if (plan && Array.isArray(plan.data)) records = plan.data;
  else records = plan == null ? [] : [structuredPayload(plan)];
  const text = records.map((r) => JSON.stringify(r)).join("\n");
  return buf(text + (records.length ? "\n" : ""), "application/x-ndjson", "ndjson");
}

// ── ics (RFC 5545) ──────────────────────────────────────────────────────
function icsEscape(s) {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// Accepts a Date, an ISO-8601 string, or an already-basic stamp
// (YYYYMMDD / YYYYMMDDTHHMMSSZ) and returns RFC-5545 basic format.
function icsDate(value) {
  if (value == null) return null;
  if (/^\d{8}(T\d{6}Z?)?$/.test(String(value))) return String(value);
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function foldLine(line) {
  // RFC 5545 §3.1: fold lines longer than 75 octets. Simple char-based
  // fold (sufficient for our ASCII-escaped content).
  if (line.length <= 75) return line;
  let out = line.slice(0, 75);
  let rest = line.slice(75);
  while (rest.length > 74) {
    out += "\r\n " + rest.slice(0, 74);
    rest = rest.slice(74);
  }
  return out + "\r\n " + rest;
}

function generateIcs(plan) {
  const events = Array.isArray(plan && plan.events)
    ? plan.events
    : Array.isArray(plan)
      ? plan
      : plan && plan.summary
        ? [plan]
        : [];
  const prodId = (plan && plan.prodId) || "-//SiraGPT//Document Pipeline//EN";
  const dtstampDefault = icsDate((plan && plan.dtstamp) || new Date());
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:${icsEscape(prodId)}`, "CALSCALE:GREGORIAN"];
  events.forEach((ev, i) => {
    if (!ev || typeof ev !== "object") return;
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${icsEscape(ev.uid || `${i + 1}-${prodId}`)}`);
    lines.push(`DTSTAMP:${icsDate(ev.dtstamp) || dtstampDefault}`);
    const start = icsDate(ev.start || ev.dtstart);
    const end = icsDate(ev.end || ev.dtend);
    if (start) lines.push(`DTSTART:${start}`);
    if (end) lines.push(`DTEND:${end}`);
    if (ev.summary) lines.push(`SUMMARY:${icsEscape(ev.summary)}`);
    if (ev.description) lines.push(`DESCRIPTION:${icsEscape(ev.description)}`);
    if (ev.location) lines.push(`LOCATION:${icsEscape(ev.location)}`);
    lines.push("END:VEVENT");
  });
  lines.push("END:VCALENDAR");
  return buf(lines.map(foldLine).join("\r\n") + "\r\n", "text/calendar", "ics");
}

// ── vcf (RFC 6350 vCard 3.0) ─────────────────────────────────────────────
function vcfEscape(s) {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function vcardName(n) {
  // N field is structured: Family;Given;Additional;Prefix;Suffix
  if (typeof n === "string") return `${vcfEscape(n)};;;;`;
  if (n && typeof n === "object") {
    return [n.family, n.given, n.additional, n.prefix, n.suffix].map((p) => vcfEscape(p || "")).join(";");
  }
  return ";;;;";
}

function generateVcf(plan) {
  const contacts = Array.isArray(plan && plan.contacts)
    ? plan.contacts
    : Array.isArray(plan)
      ? plan
      : plan && (plan.fn || plan.name || plan.n)
        ? [plan]
        : [];
  const cards = contacts
    .filter((c) => c && typeof c === "object")
    .map((c) => {
      const fn = c.fn || c.name || (typeof c.n === "string" ? c.n : "") || "";
      const lines = ["BEGIN:VCARD", "VERSION:3.0", `FN:${vcfEscape(fn)}`, `N:${vcardName(c.n || fn)}`];
      if (c.org) lines.push(`ORG:${vcfEscape(c.org)}`);
      if (c.title) lines.push(`TITLE:${vcfEscape(c.title)}`);
      for (const email of [].concat(c.email || [])) {
        if (email) lines.push(`EMAIL;TYPE=INTERNET:${vcfEscape(email)}`);
      }
      for (const tel of [].concat(c.tel || c.phone || [])) {
        if (tel) lines.push(`TEL:${vcfEscape(tel)}`);
      }
      if (c.url) lines.push(`URL:${vcfEscape(c.url)}`);
      if (c.note) lines.push(`NOTE:${vcfEscape(c.note)}`);
      lines.push("END:VCARD");
      return lines.join("\r\n");
    });
  return buf(cards.join("\r\n") + (cards.length ? "\r\n" : ""), "text/vcard", "vcf");
}

// ── bibtex ──────────────────────────────────────────────────────────────
function bibValue(v) {
  // Wrap in braces; balance is the author's responsibility, but we strip
  // any stray unbalanced braces to keep the entry parseable.
  return String(v ?? "").replace(/[{}]/g, "");
}

function generateBibtex(plan) {
  const entries = Array.isArray(plan && plan.entries)
    ? plan.entries
    : Array.isArray(plan)
      ? plan
      : plan && plan.key
        ? [plan]
        : [];
  const out = entries
    .filter((e) => e && typeof e === "object")
    .map((e, i) => {
      const type = (e.type || "misc").replace(/[^a-z]/gi, "").toLowerCase() || "misc";
      const key = (e.key || `ref${i + 1}`).replace(/[^A-Za-z0-9_:-]/g, "");
      const fields = e.fields && typeof e.fields === "object" ? e.fields : e;
      const fieldLines = Object.keys(fields)
        .filter((k) => !["type", "key", "fields"].includes(k) && fields[k] != null)
        .map((k) => `  ${k} = {${bibValue(fields[k])}}`)
        .join(",\n");
      return `@${type}{${key},\n${fieldLines}\n}`;
    });
  return buf(out.join("\n\n") + (out.length ? "\n" : ""), "application/x-bibtex", "bib");
}

module.exports = {
  generateText,
  generateJson,
  generateCsv,
  generateTsv,
  generateYaml,
  generateXml,
  generateNdjson,
  generateIcs,
  generateVcf,
  generateBibtex,
  // exported for unit tests
  _internals: { tabularize, csvField, icsDate, xmlName },
};
