'use strict';

/**
 * document-grpc-refs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects gRPC service, method, and package references — both in .proto IDL
 * and in client-side wire references (`/package.Service/Method`,
 * `client.Method(...)`).
 *
 * Targets:
 *   - .proto package:   package foo.bar.v1;
 *   - .proto service:   service UserService { rpc GetUser(...) returns (...); }
 *   - rpc methods:      rpc GetUser (GetUserRequest) returns (User) {}
 *   - wire paths:       /foo.bar.v1.UserService/GetUser
 *   - imports:          import "google/protobuf/empty.proto";
 *
 * Public API:
 *   extractGrpcRefs(text)            → { entries, totals, total }
 *   buildGrpcRefsForFiles(files)     → { perFile, aggregate, totals }
 *   renderGrpcRefsBlock(report)      → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

const PACKAGE_RE = /\bpackage\s+([a-z][a-z0-9_.]*[a-z0-9])\s*;/gi;
const SERVICE_RE = /\bservice\s+([A-Z][A-Za-z0-9_]{2,60})\s*\{/g;
const RPC_RE = /\brpc\s+([A-Z][A-Za-z0-9_]{2,60})\s*\(\s*(?:stream\s+)?([A-Za-z][A-Za-z0-9_.]{1,80})\s*\)\s*returns\s*\(\s*(?:stream\s+)?([A-Za-z][A-Za-z0-9_.]{1,80})\s*\)/g;
const WIRE_RE = /\/([a-z][a-z0-9_.]{2,60})\.([A-Z][A-Za-z0-9_]{2,60})\/([A-Z][A-Za-z0-9_]{2,60})\b/g;

function extractGrpcRefs(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { package: 0, service: 0, rpc: 0, wire: 0 };

  // Packages
  PACKAGE_RE.lastIndex = 0;
  let m;
  while ((m = PACKAGE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const pkg = m[1];
    const key = `pkg:${pkg}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind: 'package', name: pkg });
    totals.package += 1;
  }

  // Services
  if (entries.length < MAX_PER_FILE) {
    SERVICE_RE.lastIndex = 0;
    while ((m = SERVICE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const svc = m[1];
      const key = `svc:${svc}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind: 'service', name: svc });
      totals.service += 1;
    }
  }

  // RPC methods (with request/response types)
  if (entries.length < MAX_PER_FILE) {
    RPC_RE.lastIndex = 0;
    while ((m = RPC_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const name = m[1];
      const reqType = m[2];
      const resType = m[3];
      const key = `rpc:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind: 'rpc', name, request: reqType, response: resType });
      totals.rpc += 1;
    }
  }

  // Wire paths
  if (entries.length < MAX_PER_FILE) {
    WIRE_RE.lastIndex = 0;
    while ((m = WIRE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const fqn = `${m[1]}.${m[2]}/${m[3]}`;
      const key = `wire:${fqn}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind: 'wire', name: fqn, package: m[1], service: m[2], method: m[3] });
      totals.wire += 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildGrpcRefsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { package: 0, service: 0, rpc: 0, wire: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractGrpcRefs(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.name}`;
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

function renderGrpcRefsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## gRPC / PROTOBUF REFERENCES'];
  const t = report.totals || {};
  const parts = [];
  if (t.package) parts.push(`package: ${t.package}`);
  if (t.service) parts.push(`service: ${t.service}`);
  if (t.rpc) parts.push(`rpc: ${t.rpc}`);
  if (t.wire) parts.push(`wire: ${t.wire}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      if (e.kind === 'rpc') {
        lines.push(`- rpc \`${e.name}\` (${e.request} → ${e.response})`);
      } else if (e.kind === 'wire') {
        lines.push(`- wire \`/${e.name}\``);
      } else {
        lines.push(`- ${e.kind} \`${e.name}\``);
      }
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractGrpcRefs,
  buildGrpcRefsForFiles,
  renderGrpcRefsBlock,
};
