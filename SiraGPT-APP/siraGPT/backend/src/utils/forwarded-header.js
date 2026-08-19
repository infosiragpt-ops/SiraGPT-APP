'use strict';

/**
 * forwarded-header — RFC 7239 Forwarded header parser plus the
 * standard "trust N hops + walk back" client-resolution logic.
 *
 * Why bother when express-rate-limit / morgan already parse
 * X-Forwarded-For? Because the legacy XFF chain is ambiguous, lossy
 * (no proto/host), and trivial to spoof if you trust the wrong hop.
 * RFC 7239's Forwarded header carries proto/host/by/for in a single
 * structured value. This helper:
 *
 *   1. Parses Forwarded: into an ordered array of hop entries.
 *    2. Falls back to X-Forwarded-* when Forwarded is absent.
 *   3. Resolves the *real* client by walking back from the rightmost
 *      hop, skipping `trustHops` proxies and refusing to trust beyond
 *      that. This is the same algorithm Express's `trust proxy` count
 *      mode uses, lifted out so it can be tested in isolation.
 *
 * Public API:
 *   parse(header)                                — array of hop entries
 *   parseXForwardedFor(header)                   — array of IP strings
 *   resolveClient(req, { trustHops })            — { ip, proto, host }
 */

const PAIR_RE = /([!#$%&'*+\-.^_`|~0-9A-Za-z]+)=("(?:[^"\\]|\\.)*"|[^;,\s]*)/g;

function unquote(v) {
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
    return v.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return v;
}

function parse(header) {
  if (typeof header !== 'string' || header.length === 0) return [];
  const out = [];
  // Top-level commas separate hops; semicolons separate params within a hop.
  const hops = splitTop(header, ',');
  for (const hop of hops) {
    const entry = {};
    PAIR_RE.lastIndex = 0;
    let m;
    while ((m = PAIR_RE.exec(hop)) !== null) {
      const k = m[1].toLowerCase();
      entry[k] = unquote(m[2]);
    }
    if (Object.keys(entry).length > 0) out.push(entry);
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

function parseXForwardedFor(header) {
  if (typeof header !== 'string' || header.length === 0) return [];
  return header.split(',').map((s) => s.trim()).filter(Boolean);
}

function stripPort(host) {
  if (!host) return host;
  if (host.startsWith('[')) {
    // IPv6 literal in brackets: [::1]:443 → ::1
    const close = host.indexOf(']');
    return close === -1 ? host : host.slice(1, close);
  }
  const colon = host.indexOf(':');
  if (colon === -1) return host;
  // Bare IPv6 with no brackets and >1 colon: keep as is
  if (host.indexOf(':', colon + 1) !== -1) return host;
  return host.slice(0, colon);
}

function getHeader(req, name) {
  if (!req || typeof req !== 'object') return undefined;
  const h = req.headers || {};
  const v = h[name.toLowerCase()] ?? h[name];
  return Array.isArray(v) ? v[0] : v;
}

function resolveClient(req, opts = {}) {
  const trustHops = Math.max(0, Number(opts.trustHops) || 0);
  const fallbackIp = req && req.socket && req.socket.remoteAddress
    ? req.socket.remoteAddress
    : (req && req.ip) || undefined;
  const fallbackProto = req && req.socket && req.socket.encrypted ? 'https' : 'http';
  const fallbackHost = getHeader(req, 'host');

  const fwd = parse(getHeader(req, 'forwarded'));
  if (fwd.length > 0) {
    // Walk from right to left, skipping `trustHops` proxies.
    const idx = Math.max(0, fwd.length - 1 - trustHops);
    const hop = fwd[idx];
    return {
      ip: stripPort(hop.for) || fallbackIp,
      proto: (hop.proto || fallbackProto || '').toLowerCase(),
      host: hop.host || fallbackHost,
    };
  }

  const xff = parseXForwardedFor(getHeader(req, 'x-forwarded-for'));
  let ip = fallbackIp;
  if (xff.length > 0) {
    const idx = Math.max(0, xff.length - 1 - trustHops);
    ip = stripPort(xff[idx]) || fallbackIp;
  }
  const proto = (getHeader(req, 'x-forwarded-proto') || fallbackProto || '').toLowerCase();
  const host = getHeader(req, 'x-forwarded-host') || fallbackHost;
  return { ip, proto, host };
}

module.exports = {
  parse,
  parseXForwardedFor,
  resolveClient,
};
