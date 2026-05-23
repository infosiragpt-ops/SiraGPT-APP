'use strict';

/**
 * document-attack-patterns.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects common web-attack signatures in log analysis / security incident
 * reports. PURPOSE: defensive triage — "are we seeing SQLi probes?", "how
 * many path-traversal attempts hit /admin?". NOT an attack tool.
 *
 * Categories (OWASP Top 10 alignment):
 *   - sqli:       UNION SELECT, ' OR '1'='1, sleep(), benchmark(), --
 *   - xss:        <script>, javascript:, onerror=, onload=
 *   - lfi/rfi:    ../../, %2e%2e/, /etc/passwd, php://input
 *   - cmdi:       ; cat /, | nc -, $(curl …), backtick command
 *   - ssrf:       file://, gopher://, 169.254.169.254 (AWS metadata)
 *   - log4shell:  ${jndi:ldap://…}
 *   - sstti:      {{7*7}}, {%if%}, #{7*7}, ${T(java)}
 *
 * Public API:
 *   extractAttackPatterns(text)            → { entries, totals, total }
 *   buildAttackPatternsForFiles(files)     → { perFile, aggregate, totals }
 *   renderAttackPatternsBlock(report)      → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 20;
const MAX_BLOCK_CHARS = 4500;

const PATTERNS = [
  // SQL injection
  { re: /\b(?:UNION\s+(?:ALL\s+)?SELECT|SELECT\s+.*\sFROM\s+information_schema)\b/gi, kind: 'sqli', label: 'union-select' },
  { re: /\b(?:'|\bOR\b|\bAND\b)\s*\d+\s*=\s*\d+(?:--|#|\/\*)/gi, kind: 'sqli', label: 'tautology' },
  { re: /\b(?:sleep\(\d+\)|benchmark\s*\(\d+,)/gi, kind: 'sqli', label: 'time-based' },
  // XSS
  { re: /<script[\s>]/gi, kind: 'xss', label: 'script-tag' },
  { re: /\bjavascript\s*:\s*(?:alert|prompt|confirm|eval)/gi, kind: 'xss', label: 'javascript-url' },
  { re: /\bon(?:error|load|click|focus|mouseover)\s*=\s*['"]?(?:alert|eval|prompt)/gi, kind: 'xss', label: 'event-handler' },
  // LFI / Path traversal
  { re: /(?:\.\.\/|\.\.\\|%2e%2e%2f|%2e%2e\/|%2e%2e%5c){2,}/gi, kind: 'lfi', label: 'path-traversal' },
  { re: /\/etc\/passwd\b|\/proc\/self\/environ\b|\/windows\/win\.ini\b/gi, kind: 'lfi', label: 'sensitive-file' },
  { re: /\bphp:\/\/(?:input|filter|expect)/gi, kind: 'lfi', label: 'php-wrapper' },
  // Command injection
  { re: /[;&|]\s*(?:nc|netcat|curl|wget|bash|sh)\s+(?:-[a-z]|http|tcp|\/)/gi, kind: 'cmdi', label: 'shell-chain' },
  { re: /\$\(\s*(?:curl|wget|nc|bash)/gi, kind: 'cmdi', label: 'command-substitution' },
  // SSRF
  { re: /\b(?:file|gopher|dict|jar):\/\//gi, kind: 'ssrf', label: 'protocol-smuggling' },
  { re: /\b169\.254\.169\.254\b/g, kind: 'ssrf', label: 'cloud-metadata' },
  // Log4Shell
  { re: /\$\{jndi:(?:ldap|rmi|dns|ldaps):\/\//gi, kind: 'log4shell', label: 'jndi-lookup' },
  // SSTI
  { re: /\{\{\s*\d+\s*\*\s*\d+\s*\}\}/g, kind: 'ssti', label: 'jinja-twig' },
  { re: /\$\{T\([A-Za-z.]+\)/g, kind: 'ssti', label: 'spring-spel' },
  { re: /#\{\s*\d+\s*[+*]\s*\d+\s*\}/g, kind: 'ssti', label: 'ruby-erb' },
];

function extractAttackPatterns(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { sqli: 0, xss: 0, lfi: 0, cmdi: 0, ssrf: 0, log4shell: 0, ssti: 0 };

  for (const { re, kind, label } of PATTERNS) {
    if (entries.length >= MAX_PER_FILE) break;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(body)) && entries.length < MAX_PER_FILE) {
      const snippet = m[0].slice(0, 50);
      const key = `${kind}:${label}:${snippet}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind, label, snippet });
      if (totals[kind] != null) totals[kind] += 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildAttackPatternsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { sqli: 0, xss: 0, lfi: 0, cmdi: 0, ssrf: 0, log4shell: 0, ssti: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractAttackPatterns(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.label}:${e.snippet}`;
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

function renderAttackPatternsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## ATTACK PATTERN SIGNATURES', '- Defensive triage only — flags suspicious strings in logs / incident reports'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- [${e.kind}] ${e.label}: \`${e.snippet}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractAttackPatterns,
  buildAttackPatternsForFiles,
  renderAttackPatternsBlock,
};
