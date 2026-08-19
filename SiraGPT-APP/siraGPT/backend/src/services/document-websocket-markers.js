'use strict';

/**
 * document-websocket-markers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects WebSocket-protocol artefacts in code / runbooks:
 *
 *   - ws:// and wss:// URLs
 *   - upgrade handshake: Sec-WebSocket-Key/Accept/Version/Protocol/Extensions
 *   - opcode references: TEXT/BINARY/PING/PONG/CLOSE frames
 *   - ping intervals, max payload sizes
 *   - subprotocols: graphql-ws, mqtt, soap, etc.
 *
 * Public API:
 *   extractWebsocketMarkers(text)             → { entries, totals, total }
 *   buildWebsocketMarkersForFiles(files)      → { perFile, aggregate, totals }
 *   renderWebsocketMarkersBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4500;

const WS_URL_RE = /\b(wss?:\/\/[A-Za-z0-9.:_-]{2,200}(?:\/[A-Za-z0-9._%?#&=/-]{0,200})?)/g;
const HEADER_RE = /\b(Sec-WebSocket-(?:Key|Accept|Version|Protocol|Extensions))\s*:\s*([^\n\r]{1,200})/g;
const OPCODE_RE = /\b(TEXT|BINARY|PING|PONG|CLOSE)\s+(?:frame|opcode|message)\b/gi;
const SUBPROTO_RE = /\b(graphql-ws|graphql-transport-ws|mqtt(?:v\d)?|soap|sip|stomp|wamp|amqp|cbor|json-rpc)\b/gi;
const PING_INTERVAL_RE = /\b(?:ping[-_]?interval|heartbeat[-_]?interval|keepalive)\s*[:=]\s*(\d{1,7})/gi;

function extractWebsocketMarkers(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { url: 0, header: 0, opcode: 0, subproto: 0, interval: 0 };

  function push(kind, value) {
    const key = `${kind}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, value });
    if (totals[kind] != null) totals[kind] += 1;
  }

  WS_URL_RE.lastIndex = 0;
  let m;
  while ((m = WS_URL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('url', m[1].slice(0, 150));
  }
  if (entries.length < MAX_PER_FILE) {
    HEADER_RE.lastIndex = 0;
    while ((m = HEADER_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('header', `${m[1]}: ${m[2].slice(0, 60)}`);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    OPCODE_RE.lastIndex = 0;
    while ((m = OPCODE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('opcode', m[1].toUpperCase());
    }
  }
  if (entries.length < MAX_PER_FILE) {
    SUBPROTO_RE.lastIndex = 0;
    while ((m = SUBPROTO_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('subproto', m[1]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    PING_INTERVAL_RE.lastIndex = 0;
    while ((m = PING_INTERVAL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('interval', m[1]);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildWebsocketMarkersForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { url: 0, header: 0, opcode: 0, subproto: 0, interval: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractWebsocketMarkers(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.value}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderWebsocketMarkersBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## WEBSOCKET MARKERS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      lines.push(`- [${e.kind}] \`${e.value}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractWebsocketMarkers,
  buildWebsocketMarkersForFiles,
  renderWebsocketMarkersBlock,
};
