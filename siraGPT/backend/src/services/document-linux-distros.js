'use strict';

/**
 * document-linux-distros.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Linux distribution name + version references:
 *
 *   - Ubuntu 22.04 / Ubuntu Jammy / Ubuntu 24.04 LTS
 *   - Debian 12 / Debian Bookworm
 *   - Alpine 3.19 / Alpine Linux 3.18
 *   - RHEL 9 / Red Hat Enterprise Linux 9 / Rocky 9 / AlmaLinux 9
 *   - Fedora 39 / openSUSE Leap 15.5 / Arch
 *   - Amazon Linux 2 / AL2023
 *
 * Public API:
 *   extractLinuxDistros(text)             → { entries, totals, total }
 *   buildLinuxDistrosForFiles(files)      → { perFile, aggregate, totals }
 *   renderLinuxDistrosBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 18;
const MAX_BLOCK_CHARS = 4500;

const DISTROS = [
  { re: /\bUbuntu\s+(\d{2}\.\d{2})(?:\s+LTS)?\b/g, name: 'Ubuntu' },
  { re: /\bUbuntu\s+(focal|jammy|noble|mantic|lunar|kinetic|bionic|xenial|trusty|impish|hirsute|groovy)\b/gi, name: 'Ubuntu' },
  { re: /\bDebian\s+(\d{1,2})(?:\.\d{1,2})?\b/g, name: 'Debian' },
  { re: /\bDebian\s+(bookworm|bullseye|buster|stretch|jessie|sid)\b/gi, name: 'Debian' },
  { re: /\bAlpine(?:\s+Linux)?\s+(\d{1,2}\.\d{1,2}(?:\.\d{1,3})?)\b/g, name: 'Alpine' },
  { re: /\b(?:RHEL|Red\s+Hat\s+Enterprise\s+Linux)\s+(\d{1,2}(?:\.\d{1,2})?)\b/g, name: 'RHEL' },
  { re: /\bCentOS(?:\s+Stream)?\s+(\d{1,2})\b/g, name: 'CentOS' },
  { re: /\bRocky(?:\s+Linux)?\s+(\d{1,2}(?:\.\d{1,2})?)\b/g, name: 'Rocky' },
  { re: /\b(?:AlmaLinux|Alma)\s+(\d{1,2}(?:\.\d{1,2})?)\b/g, name: 'AlmaLinux' },
  { re: /\bFedora(?:\s+Linux)?\s+(\d{2,3})\b/g, name: 'Fedora' },
  { re: /\bopenSUSE(?:\s+(Leap|Tumbleweed))?(?:\s+(\d{2}\.\d{1,2}))?\b/g, name: 'openSUSE' },
  { re: /\bSLES\s+(\d{1,2}(?:\.\d{1,2})?)\b/g, name: 'SLES' },
  { re: /\bArch(?:\s+Linux)?\b/g, name: 'Arch' },
  { re: /\bGentoo(?:\s+Linux)?\b/g, name: 'Gentoo' },
  { re: /\b(?:Amazon\s+Linux|AL)\s*(\d{1,4})\b/g, name: 'Amazon Linux' },
  { re: /\bAL2023\b/g, name: 'Amazon Linux' },
];

function extractLinuxDistros(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = {};

  for (const { re, name } of DISTROS) {
    if (entries.length >= MAX_PER_FILE) break;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(body)) && entries.length < MAX_PER_FILE) {
      const version = m[1] || (name === 'Amazon Linux' && /AL2023/.test(m[0]) ? '2023' : null);
      const key = `${name}:${version || 'any'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ distro: name, version, raw: m[0].slice(0, 50) });
      totals[name] = (totals[name] || 0) + 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildLinuxDistrosForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {};
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractLinuxDistros(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.distro}:${e.version || 'any'}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      totals[e.distro] = (totals[e.distro] || 0) + 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderLinuxDistrosBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## LINUX DISTRIBUTIONS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      const ver = e.version ? ` ${e.version}` : '';
      lines.push(`- ${e.distro}${ver}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractLinuxDistros,
  buildLinuxDistrosForFiles,
  renderLinuxDistrosBlock,
};
