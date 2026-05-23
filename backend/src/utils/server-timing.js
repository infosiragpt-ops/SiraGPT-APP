'use strict';

/**
 * server-timing — W3C Server-Timing header builder + parser.
 *
 * Format: `name;dur=ms[;desc="..."]` repeated, comma-separated.
 *   `auth;dur=12.5;desc="JWT verify", db;dur=78.2, render;dur=4.1`
 *
 * Browser DevTools surfaces these in the Network → Timing tab, so
 * exposing per-stage durations from the request middleware gives
 * frontend devs a free waterfall without instrumentation. Pairs
 * with the EWMA tracker for rolling averages and the structured
 * logger for correlated trace records.
 *
 * Public API:
 *   const t = createServerTimer()
 *   t.mark('auth')                   — start a stage
 *   t.end('auth', { desc })          — close a stage and record duration
 *   t.add('db', durMs, { desc })     — record without start/end
 *   t.toHeader()                     — serialize to Server-Timing value
 *
 *   build([{ name, dur, desc }])     — pure builder
 *   parse(header)                    — array of { name, dur, desc }
 */

const NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function quoteDesc(desc) {
  // RFC 7230 quoted-string. Escape \ and ".
  return '"' + String(desc).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function build(entries) {
  if (!Array.isArray(entries)) throw new TypeError('server-timing: build expects array');
  const parts = [];
  for (const e of entries) {
    if (!e || typeof e.name !== 'string' || !NAME_RE.test(e.name)) {
      throw new TypeError(`server-timing: invalid name "${e && e.name}"`);
    }
    let s = e.name;
    if (typeof e.dur === 'number' && Number.isFinite(e.dur)) {
      s += `;dur=${roundMs(e.dur)}`;
    }
    if (e.desc !== undefined && e.desc !== null && e.desc !== '') {
      s += `;desc=${quoteDesc(e.desc)}`;
    }
    parts.push(s);
  }
  return parts.join(', ');
}

function roundMs(n) {
  // 2 decimal places is the conventional precision (millis with
  // sub-ms granularity). Strip trailing zeros for compactness.
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function parse(header) {
  if (typeof header !== 'string' || header.length === 0) return [];
  const out = [];
  for (const raw of splitTop(header, ',')) {
    const segs = splitTop(raw, ';').map((s) => s.trim()).filter(Boolean);
    if (segs.length === 0) continue;
    const name = segs[0];
    if (!NAME_RE.test(name)) continue;
    const entry = { name };
    for (let i = 1; i < segs.length; i++) {
      const eq = segs[i].indexOf('=');
      if (eq === -1) continue;
      const k = segs[i].slice(0, eq).toLowerCase();
      let v = segs[i].slice(eq + 1);
      if (v.startsWith('"') && v.endsWith('"')) {
        v = v.slice(1, -1).replace(/\\(.)/g, '$1');
      }
      if (k === 'dur') {
        const n = Number(v);
        if (Number.isFinite(n)) entry.dur = n;
      } else if (k === 'desc') {
        entry.desc = v;
      } else {
        entry[k] = v;
      }
    }
    out.push(entry);
  }
  return out;
}

function splitTop(s, sep) {
  const out = [];
  let buf = '';
  let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '\\' && i + 1 < s.length) { buf += c + s[++i]; continue; }
      if (c === '"') inQ = false;
      buf += c; continue;
    }
    if (c === '"') { inQ = true; buf += c; continue; }
    if (c === sep) { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

function createServerTimer(opts = {}) {
  const now = typeof opts.now === 'function'
    ? opts.now
    : (typeof performance !== 'undefined' && performance.now
        ? () => performance.now()
        : () => {
            const [s, ns] = process.hrtime();
            return s * 1e3 + ns / 1e6;
          });
  const opens = new Map();
  const entries = [];

  function mark(name) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw new TypeError(`server-timing: invalid mark name "${name}"`);
    }
    opens.set(name, now());
    return name;
  }

  function end(name, meta = {}) {
    const start = opens.get(name);
    if (start === undefined) return undefined;
    opens.delete(name);
    const dur = now() - start;
    const entry = { name, dur };
    if (meta.desc) entry.desc = meta.desc;
    entries.push(entry);
    return dur;
  }

  function add(name, durMs, meta = {}) {
    if (!NAME_RE.test(name)) throw new TypeError(`server-timing: invalid name "${name}"`);
    const entry = { name, dur: Number(durMs) || 0 };
    if (meta.desc) entry.desc = meta.desc;
    entries.push(entry);
  }

  function toHeader() {
    return build(entries);
  }

  return { mark, end, add, toHeader, entries: () => entries.slice() };
}

module.exports = {
  build,
  parse,
  createServerTimer,
};
