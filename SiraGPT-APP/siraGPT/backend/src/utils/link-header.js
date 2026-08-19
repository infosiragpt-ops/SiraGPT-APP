'use strict';

/**
 * link-header — RFC 8288 Web Linking parser/builder for the HTTP
 * `Link` header.
 *
 * Used for paginated API responses (rel=next/prev/first/last) and
 * hypermedia (rel=self/up/related/profile). Pairs with the
 * pagination-cursor helper: cursor produces the offset, this
 * helper wraps it in the standard transport.
 *
 * Public API:
 *   parse(header)   → [{ uri, rel, ...params }]
 *   build(links)    → header value
 *   findRel(links, rel)
 *
 * Multi-value rels ("rel=\"next prev\"") expand into one entry per
 * rel value when parsing, and are joined when building (a single
 * link with rel: ['next', 'prev'] emits one entry).
 */

function parse(header) {
  if (typeof header !== 'string' || header.length === 0) return [];
  const out = [];
  // Split on commas at top level, respecting <...> and "..." quoting.
  const parts = splitTopLevel(header, ',');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const lt = trimmed.indexOf('<');
    const gt = trimmed.indexOf('>', lt + 1);
    if (lt !== 0 || gt === -1) continue;
    const uri = trimmed.slice(1, gt);
    const tail = trimmed.slice(gt + 1).trim();
    const params = {};
    if (tail.startsWith(';')) {
      const segs = splitTopLevel(tail.slice(1), ';');
      for (const seg of segs) {
        const eq = seg.indexOf('=');
        if (eq === -1) continue;
        const k = seg.slice(0, eq).trim().toLowerCase();
        let v = seg.slice(eq + 1).trim();
        if (v.startsWith('"') && v.endsWith('"')) {
          v = v.slice(1, -1).replace(/\\(.)/g, '$1');
        }
        params[k] = v;
      }
    }
    if (params.rel) {
      const rels = String(params.rel).split(/\s+/).filter(Boolean);
      for (const rel of rels) {
        out.push(Object.assign({}, params, { uri, rel }));
      }
    } else {
      out.push(Object.assign({}, params, { uri }));
    }
  }
  return out;
}

function splitTopLevel(s, sep) {
  const out = [];
  let buf = '';
  let inQ = false;
  let inAngle = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '\\' && i + 1 < s.length) { buf += c + s[++i]; continue; }
      if (c === '"') inQ = false;
      buf += c; continue;
    }
    if (inAngle) {
      if (c === '>') inAngle = false;
      buf += c; continue;
    }
    if (c === '"') { inQ = true; buf += c; continue; }
    if (c === '<') { inAngle = true; buf += c; continue; }
    if (c === sep) { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

function build(links) {
  if (!Array.isArray(links)) {
    throw new TypeError('link-header: build expects an array');
  }
  const parts = [];
  for (const link of links) {
    if (!link || typeof link.uri !== 'string' || link.uri.length === 0) {
      throw new TypeError('link-header: each link needs a non-empty uri');
    }
    let entry = `<${link.uri}>`;
    for (const [k, v] of Object.entries(link)) {
      if (k === 'uri') continue;
      let value = v;
      if (k === 'rel' && Array.isArray(v)) value = v.join(' ');
      const safe = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      entry += `; ${k}="${safe}"`;
    }
    parts.push(entry);
  }
  return parts.join(', ');
}

function findRel(links, rel) {
  if (!Array.isArray(links) || typeof rel !== 'string') return undefined;
  for (const link of links) {
    if (link && link.rel === rel) return link;
  }
  return undefined;
}

module.exports = {
  parse,
  build,
  findRel,
};
