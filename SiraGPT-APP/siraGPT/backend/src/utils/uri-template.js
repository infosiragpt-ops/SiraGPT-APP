'use strict';

/**
 * uri-template — RFC 6570 URI template expander, levels 1–3. Handles
 * the operators: '' (default), '+' (reserved), '#' (fragment),
 * '.' (label), '/' (path), ';' (path-style param), '?' (form-style
 * query), '&' (form-continuation). Pairs with the URL canonicalizer
 * (#81) and signed-URL (#70) — building templated URLs to MCP /
 * provider endpoints without error-prone string concat.
 *
 * Spec: https://www.rfc-editor.org/rfc/rfc6570
 *
 * Public API:
 *   expand(template, vars)            → string
 *   parseTemplate(template)           → { literals, expressions } (debug)
 */

const OP_META = {
  '':  { first: '',  sep: ',', named: false, ifEmpty: '',  allow: 'U' },
  '+': { first: '',  sep: ',', named: false, ifEmpty: '',  allow: 'U+R' },
  '#': { first: '#', sep: ',', named: false, ifEmpty: '',  allow: 'U+R' },
  '.': { first: '.', sep: '.', named: false, ifEmpty: '',  allow: 'U' },
  '/': { first: '/', sep: '/', named: false, ifEmpty: '',  allow: 'U' },
  ';': { first: ';', sep: ';', named: true,  ifEmpty: '',  allow: 'U' },
  '?': { first: '?', sep: '&', named: true,  ifEmpty: '=', allow: 'U' },
  '&': { first: '&', sep: '&', named: true,  ifEmpty: '=', allow: 'U' },
};

// "Unreserved" set per RFC 3986: ALPHA / DIGIT / "-" / "." / "_" / "~"
const UNRESERVED = /[A-Za-z0-9\-._~]/;
// "Reserved + Unreserved + pct-encoded" pass-through for U+R operators.
function encode(value, allow) {
  const s = String(value);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (UNRESERVED.test(ch)) { out += ch; continue; }
    if (allow === 'U+R') {
      // Don't re-encode reserved chars or already pct-encoded triplets.
      if (/[!*'();:@&=+$,/?#[\]]/.test(ch)) { out += ch; continue; }
      if (ch === '%' && /^[0-9A-Fa-f]{2}/.test(s.slice(i + 1, i + 3))) { out += ch; continue; }
    }
    out += encodeURIComponent(ch);
  }
  return out;
}

function isUndef(v) { return v === undefined || v === null; }
function isEmptyArrayOrObject(v) {
  if (Array.isArray(v)) return v.length === 0;
  if (v && typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

function expandVar(spec, vars, op) {
  // spec: { name, explode, prefix }
  const v = vars[spec.name];
  if (isUndef(v) || isEmptyArrayOrObject(v)) return null;

  const meta = OP_META[op];
  // Scalar
  if (!Array.isArray(v) && (typeof v !== 'object' || v === null)) {
    let s = String(v);
    if (Number.isFinite(spec.prefix)) s = s.slice(0, spec.prefix);
    const enc = encode(s, meta.allow);
    if (meta.named) return `${spec.name}${enc === '' ? meta.ifEmpty : '=' + enc}`;
    return enc;
  }
  // Array
  if (Array.isArray(v)) {
    const items = v.filter((x) => !isUndef(x)).map((x) => encode(x, meta.allow));
    if (items.length === 0) return null;
    if (spec.explode) {
      if (meta.named) {
        return items.map((i) => `${spec.name}=${i}`).join(meta.sep);
      }
      return items.join(meta.sep);
    }
    if (meta.named) return `${spec.name}=${items.join(',')}`;
    return items.join(',');
  }
  // Object
  const entries = Object.entries(v).filter(([, val]) => !isUndef(val));
  if (entries.length === 0) return null;
  if (spec.explode) {
    return entries.map(([k, val]) => `${encode(k, meta.allow)}=${encode(val, meta.allow)}`).join(meta.sep);
  }
  const flat = entries.flatMap(([k, val]) => [encode(k, meta.allow), encode(val, meta.allow)]).join(',');
  if (meta.named) return `${spec.name}=${flat}`;
  return flat;
}

function parseExpression(body) {
  let op = '';
  if (Object.prototype.hasOwnProperty.call(OP_META, body[0])) {
    op = body[0];
    body = body.slice(1);
  }
  const specs = body.split(',').map((tok) => {
    let name = tok;
    let explode = false;
    let prefix = null;
    if (name.endsWith('*')) { explode = true; name = name.slice(0, -1); }
    const colon = name.indexOf(':');
    if (colon !== -1) {
      prefix = Number(name.slice(colon + 1));
      name = name.slice(0, colon);
    }
    return { name, explode, prefix };
  });
  return { op, specs };
}

function parseTemplate(template) {
  if (typeof template !== 'string') throw new TypeError('uri-template: template string required');
  const out = [];
  let i = 0;
  while (i < template.length) {
    const lb = template.indexOf('{', i);
    if (lb === -1) { out.push({ kind: 'lit', value: template.slice(i) }); break; }
    if (lb > i) out.push({ kind: 'lit', value: template.slice(i, lb) });
    const rb = template.indexOf('}', lb);
    if (rb === -1) throw new TypeError('uri-template: unterminated expression');
    out.push({ kind: 'expr', value: parseExpression(template.slice(lb + 1, rb)) });
    i = rb + 1;
  }
  return out;
}

function expand(template, vars = {}) {
  const parts = parseTemplate(template);
  let out = '';
  for (const p of parts) {
    if (p.kind === 'lit') { out += p.value; continue; }
    const meta = OP_META[p.value.op];
    const expanded = p.value.specs
      .map((spec) => expandVar(spec, vars, p.value.op))
      .filter((s) => s !== null);
    if (expanded.length === 0) continue;
    out += meta.first + expanded.join(meta.sep);
  }
  return out;
}

module.exports = {
  expand,
  parseTemplate,
};
