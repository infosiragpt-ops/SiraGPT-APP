'use strict';

/**
 * json-pointer — RFC 6901 implementation. Useful for navigating
 * deeply-nested tool-call responses, building JSON Patch operations,
 * and the structured logger's path-based field access. Pairs with
 * canonical-json (#50) and the schema validator (#27 / #60) which
 * already speak JSONPath-style paths.
 *
 * Spec: https://www.rfc-editor.org/rfc/rfc6901
 *
 * Token escapes:
 *   '~' → '~0'
 *   '/' → '~1'
 * Empty pointer '' refers to the whole document.
 *
 * Public API:
 *   parsePointer(ptr)             → string[] of unescaped tokens
 *   formatPointer(tokens)         → string  (inverse)
 *   escapeToken(t) / unescapeToken(t)
 *   get(doc, ptr)                 → value | undefined
 *   has(doc, ptr)                 → boolean
 *   set(doc, ptr, value)          → mutated doc (creates path)
 *   del(doc, ptr)                 → boolean (true if removed)
 */

function parsePointer(ptr) {
  if (typeof ptr !== 'string') throw new TypeError('json-pointer: string required');
  if (ptr === '') return [];
  if (ptr[0] !== '/') throw new TypeError('json-pointer: must start with "/" or be ""');
  return ptr.slice(1).split('/').map(unescapeToken);
}

function escapeToken(t) {
  return String(t).replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapeToken(t) {
  return t.replace(/~1/g, '/').replace(/~0/g, '~');
}

function formatPointer(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return '';
  return '/' + tokens.map(escapeToken).join('/');
}

function step(node, token) {
  if (Array.isArray(node)) {
    if (token === '-') return undefined; // RFC 6901: "-" is a virtual append index
    const i = Number(token);
    if (!Number.isInteger(i) || i < 0 || i >= node.length) return undefined;
    return node[i];
  }
  if (node !== null && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, token)) {
    return node[token];
  }
  return undefined;
}

function get(doc, ptr) {
  const tokens = parsePointer(ptr);
  let cur = doc;
  for (const t of tokens) {
    if (cur == null) return undefined;
    cur = step(cur, t);
  }
  return cur;
}

function has(doc, ptr) {
  const tokens = parsePointer(ptr);
  let cur = doc;
  for (const t of tokens) {
    if (cur == null) return false;
    if (Array.isArray(cur)) {
      const i = Number(t);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return false;
      cur = cur[i];
    } else if (typeof cur === 'object') {
      if (!Object.prototype.hasOwnProperty.call(cur, t)) return false;
      cur = cur[t];
    } else {
      return false;
    }
  }
  return true;
}

function set(doc, ptr, value) {
  const tokens = parsePointer(ptr);
  if (tokens.length === 0) {
    throw new Error('json-pointer: cannot set the root document');
  }
  let cur = doc;
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    const nextToken = tokens[i + 1];
    if (Array.isArray(cur)) {
      const idx = Number(t);
      if (!Number.isInteger(idx)) throw new Error(`json-pointer.set: array index expected at "/${tokens.slice(0, i + 1).join('/')}"`);
      if (cur[idx] == null) cur[idx] = /^\d+$|^-$/.test(nextToken) ? [] : {};
      cur = cur[idx];
    } else if (cur && typeof cur === 'object') {
      if (cur[t] == null) cur[t] = /^\d+$|^-$/.test(nextToken) ? [] : {};
      cur = cur[t];
    } else {
      throw new Error('json-pointer.set: parent is not object/array');
    }
  }
  const last = tokens[tokens.length - 1];
  if (Array.isArray(cur)) {
    if (last === '-') cur.push(value);
    else {
      const i = Number(last);
      if (!Number.isInteger(i) || i < 0) throw new Error('json-pointer.set: bad array index');
      cur[i] = value;
    }
  } else if (cur && typeof cur === 'object') {
    cur[last] = value;
  } else {
    throw new Error('json-pointer.set: parent is not object/array');
  }
  return doc;
}

function del(doc, ptr) {
  const tokens = parsePointer(ptr);
  if (tokens.length === 0) return false;
  let cur = doc;
  for (let i = 0; i < tokens.length - 1; i++) {
    cur = step(cur, tokens[i]);
    if (cur == null) return false;
  }
  const last = tokens[tokens.length - 1];
  if (Array.isArray(cur)) {
    const i = Number(last);
    if (!Number.isInteger(i) || i < 0 || i >= cur.length) return false;
    cur.splice(i, 1);
    return true;
  }
  if (cur && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, last)) {
    delete cur[last];
    return true;
  }
  return false;
}

module.exports = {
  parsePointer,
  formatPointer,
  escapeToken,
  unescapeToken,
  get,
  has,
  set,
  del,
};
