'use strict';

/**
 * document-hardware-specs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects hardware specifications in documents:
 *
 *   - CPU:   4 cores / 8-core / Intel Xeon / AMD EPYC / Apple M3 Pro / ARM64
 *   - RAM:   8GB / 16 GiB / 64GB DDR5
 *   - Disk:  256GB SSD / 1TB NVMe / 10TB HDD
 *   - GPU:   NVIDIA A100 / RTX 4090 / Tesla V100 / Apple GPU
 *   - Net:   10Gbps NIC / 1G ethernet
 *   - Arch:  x86_64 / amd64 / arm64 / aarch64 / riscv64
 *
 * Public API:
 *   extractHardwareSpecs(text)             → { entries, totals, total }
 *   buildHardwareSpecsForFiles(files)      → { perFile, aggregate, totals }
 *   renderHardwareSpecsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

const CORES_RE = /\b(\d{1,3})[- ]?(?:cores?|vCPUs?|CPUs?|cpu cores)\b/gi;
const CPU_BRAND_RE = /\b(Intel\s+(?:Xeon|Core\s+i[3579]|Pentium|Atom)|AMD\s+(?:EPYC|Ryzen|Threadripper|Opteron)|Apple\s+M[1-9](?:\s+(?:Pro|Max|Ultra))?|Qualcomm\s+Snapdragon|MediaTek)\s*(?:[A-Z0-9-]{2,30})?/g;
const RAM_RE = /\b(\d{1,4})\s*(GB|GiB|MB|MiB|TB|TiB)\s*(?:DDR[345]|RAM|memory|of\s+(?:RAM|memory))?\b/gi;
const STORAGE_RE = /\b(\d{1,4})\s*(GB|GiB|TB|TiB|PB|PiB)\s*(SSD|NVMe|HDD|disk|storage)\b/gi;
const GPU_RE = /\b(NVIDIA\s+(?:A|H|RTX|GTX|Tesla|Titan|Quadro)\s?[A-Z0-9]{1,20}|AMD\s+(?:Radeon|Instinct|MI)\s?[A-Z0-9]{1,20}|Apple\s+(?:M[1-9]|GPU))\b/g;
const NETWORK_RE = /\b(\d{1,3})\s*(Gbps|Mbps|Tbps)\s*(?:NIC|ethernet|interface|link)?/gi;
const ARCH_RE = /\b(x86[_-]?64|amd64|arm64|aarch64|riscv64|i686|x86|armv[678][a-z]?|ppc64(?:le)?|s390x|sparc64?)\b/gi;

function extractHardwareSpecs(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { cpu: 0, cores: 0, ram: 0, storage: 0, gpu: 0, network: 0, arch: 0 };

  function push(kind, value, normalised) {
    const key = `${kind}:${normalised}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, value, normalised });
    if (totals[kind] != null) totals[kind] += 1;
  }

  CORES_RE.lastIndex = 0;
  let m;
  while ((m = CORES_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const n = parseInt(m[1], 10);
    if (n < 1 || n > 256) continue;
    push('cores', m[0], `${n}-cores`);
  }

  if (entries.length < MAX_PER_FILE) {
    CPU_BRAND_RE.lastIndex = 0;
    while ((m = CPU_BRAND_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('cpu', m[0].slice(0, 60).trim(), m[0].toLowerCase().slice(0, 40));
    }
  }

  if (entries.length < MAX_PER_FILE) {
    RAM_RE.lastIndex = 0;
    while ((m = RAM_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const n = parseInt(m[1], 10);
      const unit = m[2];
      if (n < 1 || n > 2048) continue;
      push('ram', `${n}${unit}`, `${n}-${unit.toLowerCase()}`);
    }
  }

  if (entries.length < MAX_PER_FILE) {
    STORAGE_RE.lastIndex = 0;
    while ((m = STORAGE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const n = parseInt(m[1], 10);
      if (n < 1 || n > 100000) continue;
      push('storage', `${n}${m[2]} ${m[3]}`, `${n}-${m[2].toLowerCase()}-${m[3].toLowerCase()}`);
    }
  }

  if (entries.length < MAX_PER_FILE) {
    GPU_RE.lastIndex = 0;
    while ((m = GPU_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('gpu', m[0].slice(0, 60).trim(), m[0].toLowerCase().slice(0, 40));
    }
  }

  if (entries.length < MAX_PER_FILE) {
    NETWORK_RE.lastIndex = 0;
    while ((m = NETWORK_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const n = parseInt(m[1], 10);
      if (n < 1 || n > 1000) continue;
      push('network', `${n}${m[2]}`, `${n}-${m[2].toLowerCase()}`);
    }
  }

  if (entries.length < MAX_PER_FILE) {
    ARCH_RE.lastIndex = 0;
    while ((m = ARCH_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('arch', m[1], m[1].toLowerCase());
    }
  }

  return { entries, totals, total: entries.length };
}

function buildHardwareSpecsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { cpu: 0, cores: 0, ram: 0, storage: 0, gpu: 0, network: 0, arch: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractHardwareSpecs(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.normalised}`;
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

function renderHardwareSpecsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## HARDWARE SPECIFICATIONS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      lines.push(`- [${e.kind}] ${e.value}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractHardwareSpecs,
  buildHardwareSpecsForFiles,
  renderHardwareSpecsBlock,
};
