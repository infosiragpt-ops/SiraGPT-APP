'use strict';

/**
 * json-patch — RFC 6902 implementation built on top of the JSON
 * Pointer module (#65) and the deepEqual / deepClone helpers
 * (#63 / #64). Pairs with the audit log (#14) for change-event
 * narration and snapshot diffs that don't blow up payload size.
 *
 * Operations: add, remove, replace, move, copy, test.
 * apply() validates the patch atomically: if any op fails the
 * document is rolled back to its original state via a one-shot
 * deepClone snapshot.
 *
 * Spec: https://www.rfc-editor.org/rfc/rfc6902
 *
 * Public API:
 *   applyPatch(doc, ops, { mutate = false })
 *     → { ok, doc }                — when mutate false: doc is the new version
 *     → { ok: false, error, opIndex } on failure (doc is unchanged)
 *
 *   diffPatch(a, b)               → ops[] minimal-ish (replace/add/remove)
 */

const jp = require('./json-pointer');
const { deepEqual } = require('./deep-equal');
const { deepClone } = require('./deep-clone');

const OPS = new Set(['add', 'remove', 'replace', 'move', 'copy', 'test']);

function applyOp(doc, op, idx) {
  if (!op || typeof op !== 'object') throw new Error(`op[${idx}]: must be object`);
  if (!OPS.has(op.op)) throw new Error(`op[${idx}]: unknown op "${op.op}"`);
  if (typeof op.path !== 'string') throw new Error(`op[${idx}]: path required`);

  switch (op.op) {
    case 'add': {
      // RFC 6902: add inserts (does not replace). For arrays the
      // numeric index is an insertion point.
      const tokens = jp.parsePointer(op.path);
      if (tokens.length === 0) {
        // Replacing root is allowed.
        return op.value;
      }
      const parentPtr = jp.formatPointer(tokens.slice(0, -1));
      const last = tokens[tokens.length - 1];
      const parent = jp.get(doc, parentPtr);
      if (parent === undefined) throw new Error(`op[${idx}] add: parent missing at "${parentPtr}"`);
      if (Array.isArray(parent)) {
        if (last === '-') parent.push(op.value);
        else {
          const i = Number(last);
          if (!Number.isInteger(i) || i < 0 || i > parent.length) throw new Error(`op[${idx}] add: bad array index`);
          parent.splice(i, 0, op.value);
        }
      } else if (parent && typeof parent === 'object') {
        parent[last] = op.value;
      } else {
        throw new Error(`op[${idx}] add: parent is not object/array`);
      }
      return doc;
    }
    case 'remove': {
      const ok = jp.del(doc, op.path);
      if (!ok) throw new Error(`op[${idx}] remove: target missing at "${op.path}"`);
      return doc;
    }
    case 'replace': {
      if (!jp.has(doc, op.path)) throw new Error(`op[${idx}] replace: target missing at "${op.path}"`);
      jp.set(doc, op.path, op.value);
      return doc;
    }
    case 'move': {
      if (typeof op.from !== 'string') throw new Error(`op[${idx}] move: from required`);
      if (!jp.has(doc, op.from)) throw new Error(`op[${idx}] move: from missing`);
      const value = jp.get(doc, op.from);
      jp.del(doc, op.from);
      jp.set(doc, op.path, value);
      return doc;
    }
    case 'copy': {
      if (typeof op.from !== 'string') throw new Error(`op[${idx}] copy: from required`);
      if (!jp.has(doc, op.from)) throw new Error(`op[${idx}] copy: from missing`);
      const value = deepClone(jp.get(doc, op.from));
      jp.set(doc, op.path, value);
      return doc;
    }
    case 'test': {
      const cur = jp.get(doc, op.path);
      if (!deepEqual(cur, op.value)) throw new Error(`op[${idx}] test: mismatch at "${op.path}"`);
      return doc;
    }
    default:
      throw new Error(`op[${idx}] unhandled`);
  }
}

function applyPatch(doc, ops, { mutate = false } = {}) {
  if (!Array.isArray(ops)) return { ok: false, error: 'ops must be array', opIndex: -1 };
  // Atomicity: snapshot if !mutate; on any failure, return original.
  const target = mutate ? doc : deepClone(doc);
  let cur = target;
  try {
    for (let i = 0; i < ops.length; i++) cur = applyOp(cur, ops[i], i);
    return { ok: true, doc: cur };
  } catch (err) {
    return { ok: false, error: err.message, opIndex: extractOpIndex(err.message) };
  }
}

function extractOpIndex(msg) {
  const m = /^op\[(\d+)\]/.exec(msg || '');
  return m ? Number(m[1]) : -1;
}

/**
 * diffPatch — emits a minimal-ish patch that turns `a` into `b`.
 * Not optimal (no move/copy detection), but produces correct
 * add/remove/replace ops a reader can audit.
 */
function diffPatch(a, b, basePath = '') {
  const ops = [];
  if (deepEqual(a, b)) return ops;
  const isObjA = a !== null && typeof a === 'object' && !Array.isArray(a);
  const isObjB = b !== null && typeof b === 'object' && !Array.isArray(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const path = `${basePath}/${i}`;
      if (i >= a.length) ops.push({ op: 'add', path, value: b[i] });
      else if (i >= b.length) ops.push({ op: 'remove', path: `${basePath}/${b.length}` });
      else ops.push(...diffPatch(a[i], b[i], path));
    }
    return ops;
  }
  if (isObjA && isObjB) {
    const aKeys = new Set(Object.keys(a));
    const bKeys = new Set(Object.keys(b));
    for (const k of aKeys) {
      const path = `${basePath}/${jp.escapeToken(k)}`;
      if (!bKeys.has(k)) ops.push({ op: 'remove', path });
      else ops.push(...diffPatch(a[k], b[k], path));
    }
    for (const k of bKeys) {
      if (!aKeys.has(k)) ops.push({ op: 'add', path: `${basePath}/${jp.escapeToken(k)}`, value: b[k] });
    }
    return ops;
  }
  // Type changed or primitives differ.
  ops.push({ op: 'replace', path: basePath || '', value: b });
  return ops;
}

module.exports = {
  applyPatch,
  diffPatch,
  OPS,
};
