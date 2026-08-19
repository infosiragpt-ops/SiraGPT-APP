'use strict';

/**
 * document-compose-services.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects docker-compose.yml service-level constructs:
 *
 *   - services: top-level block
 *   - service definitions (2-space-indented bare keys under services:)
 *   - image: registry/image:tag
 *   - build: ./path
 *   - ports: "host:container" / 8080:80
 *   - depends_on: [a, b] / { a: { condition: ... } }
 *   - environment: KEY=VAL or { KEY: VAL }
 *   - volumes: ./local:/container:ro
 *   - networks: bridge / overlay
 *   - restart: always / on-failure / unless-stopped
 *   - healthcheck:
 *
 * Public API:
 *   extractComposeServices(text)             → { entries, totals, total }
 *   buildComposeServicesForFiles(files)      → { perFile, aggregate, totals }
 *   renderComposeServicesBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const SERVICES_BLOCK_RE = /^services\s*:\s*$/m;
const SERVICE_NAME_RE = /^[ ]{2}([a-z][a-zA-Z0-9_-]{0,40})\s*:\s*$/gm;
const IMAGE_RE = /\bimage\s*:\s*["']?([a-zA-Z0-9._\/-]+(?::[a-zA-Z0-9._-]+)?)["']?/g;
const PORTS_RE = /\bports\s*:\s*\[[^\]]{0,200}\]|\bports\s*:\s*\n((?:\s+-\s+["']?[^\n"']{1,40}["']?\s*\n){1,20})/g;
const PORT_VALUE_RE = /["']?(\d{1,5})\s*:\s*(\d{1,5})(?:\s*\/\s*(tcp|udp))?["']?/g;
const DEPENDS_RE = /\bdepends_on[ \t]*:[ \t]*(\[[^\]]{0,200}\]|(?:\n[ \t]+-[ \t]+[a-z][a-zA-Z0-9_-]{0,40}){1,10})/g;
const VOLUMES_RE = /\bvolumes\s*:\s*(?:\[|\n)((?:\s+-\s+["']?[^\n"']{1,200}["']?\s*\n){1,20})/g;
const RESTART_RE = /\brestart\s*:\s*["']?(no|always|on-failure(?::\d+)?|unless-stopped)["']?/g;
const HEALTHCHECK_RE = /\bhealthcheck\s*:\s*$/gm;
const NETWORK_DEF_RE = /^networks\s*:\s*$/gm;
const BUILD_RE = /\bbuild\s*:\s*(?:["']?([^\n"']{1,200})["']?|\{[^}]{0,300}\})/g;
const ENV_FILE_RE = /\benv_file\s*:\s*["']?([^\n"']{1,100})["']?/g;

function extractComposeServices(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;

  // Only fire when the file looks like compose
  if (!SERVICES_BLOCK_RE.test(body) && !/version\s*:\s*["']?[23]/.test(body)) {
    return { entries: [], totals: {}, total: 0 };
  }

  const seen = new Set();
  const entries = [];
  const totals = { service: 0, image: 0, port: 0, dependsOn: 0, volume: 0, restart: 0, healthcheck: 0, network: 0, build: 0, envFile: 0 };

  function push(kind, name, detail) {
    const sig = `${kind}:${name}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  SERVICE_NAME_RE.lastIndex = 0;
  let m;
  while ((m = SERVICE_NAME_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('service', m[1], null);
  }
  if (entries.length < MAX_PER_FILE) {
    IMAGE_RE.lastIndex = 0;
    while ((m = IMAGE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('image', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    PORT_VALUE_RE.lastIndex = 0;
    while ((m = PORT_VALUE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('port', `${m[1]}:${m[2]}`, m[3] || 'tcp');
    }
  }
  if (entries.length < MAX_PER_FILE) {
    DEPENDS_RE.lastIndex = 0;
    while ((m = DEPENDS_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const items = m[1].match(/[a-z][a-zA-Z0-9_-]{0,40}/g) || [];
      for (const name of items.slice(0, 5)) {
        if (entries.length >= MAX_PER_FILE) break;
        push('dependsOn', name, null);
      }
    }
  }
  if (entries.length < MAX_PER_FILE) {
    RESTART_RE.lastIndex = 0;
    while ((m = RESTART_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('restart', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    BUILD_RE.lastIndex = 0;
    while ((m = BUILD_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const ctx = (m[1] || 'inline').slice(0, 40);
      push('build', ctx, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    ENV_FILE_RE.lastIndex = 0;
    while ((m = ENV_FILE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('envFile', m[1].slice(0, 50), null);
    }
  }

  let healthCount = 0;
  HEALTHCHECK_RE.lastIndex = 0;
  while (HEALTHCHECK_RE.exec(body) && healthCount < 20) healthCount += 1;
  totals.healthcheck = healthCount;

  let netCount = 0;
  NETWORK_DEF_RE.lastIndex = 0;
  while (NETWORK_DEF_RE.exec(body) && netCount < 5) netCount += 1;
  totals.network = netCount;

  return { entries, totals, total: entries.length };
}

function buildComposeServicesForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { service: 0, image: 0, port: 0, dependsOn: 0, volume: 0, restart: 0, healthcheck: 0, network: 0, build: 0, envFile: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractComposeServices(txt);
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

function renderComposeServicesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## DOCKER COMPOSE SERVICES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      const det = e.detail ? ` (${e.detail})` : '';
      lines.push(`- [${e.kind}] \`${e.name}\`${det}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractComposeServices,
  buildComposeServicesForFiles,
  renderComposeServicesBlock,
};
