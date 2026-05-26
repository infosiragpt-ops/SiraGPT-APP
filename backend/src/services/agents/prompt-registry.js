'use strict';

/**
 * prompt-registry — versioned, content-addressable registry for prompt
 * templates. Each registered template gets a deterministic content
 * hash and a semver-style version tag. The renderer surfaces the
 * lineage triple (id, version, hash) the agent should attach to every
 * response so an operator debugging a regression can answer
 * "which exact template emitted this answer".
 *
 * Public API:
 *   const reg = createPromptRegistry()
 *   const t = reg.register({
 *     id: 'agent.system',
 *     version: '1.2.0',
 *     template: 'You are {role}. Today is {date}.',
 *     vars,           // optional Set of allowed var names
 *   })
 *   reg.list()                              → metadata snapshot
 *   reg.get(id, version?)                   → template entry (latest if no version)
 *   reg.versions(id)                        → string[] (semver-sorted desc)
 *   reg.render(id, vars, { version? })      → { text, lineage: { id, version, hash } }
 *   reg.lineageFor(id, version?)            → { id, version, hash }
 *
 * Hash = sha256(template), so an unchanged template always re-hashes
 * to the same value across processes. Versions are unique per id and
 * compared semver-style; latest = highest semver.
 */

const { createHash } = require('node:crypto');

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const VAR_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

function parseSemver(v) {
  const m = SEMVER_RE.exec(String(v || ''));
  if (!m) throw new TypeError(`prompt-registry: bad semver "${v}" (use major.minor.patch)`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemver(a, b) {
  const [aM, am, ap] = parseSemver(a);
  const [bM, bm, bp] = parseSemver(b);
  if (aM !== bM) return aM - bM;
  if (am !== bm) return am - bm;
  return ap - bp;
}

function hashTemplate(template) {
  return createHash('sha256').update(String(template || '')).digest('hex');
}

function extractVars(template) {
  const out = new Set();
  let m;
  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(template)) != null) out.add(m[1]);
  return out;
}

function createPromptRegistry() {
  /** @type {Map<string, Map<string, {id,version,template,hash,vars,createdAt}>>} */
  const byId = new Map();

  function register({ id, version, template, vars = null } = {}) {
    if (typeof id !== 'string' || !id) throw new TypeError('prompt-registry.register: id required');
    if (typeof template !== 'string' || !template) throw new TypeError('prompt-registry.register: template required');
    parseSemver(version); // validate
    const inner = byId.get(id) || new Map();
    if (inner.has(version)) {
      const existing = inner.get(version);
      if (existing.template !== template) {
        throw new Error(`prompt-registry: id="${id}" version=${version} already registered with different content`);
      }
      return existing;
    }
    const declaredVars = vars instanceof Set
      ? new Set([...vars])
      : Array.isArray(vars)
        ? new Set(vars)
        : null;
    const inferred = extractVars(template);
    if (declaredVars) {
      for (const v of inferred) {
        if (!declaredVars.has(v)) {
          throw new Error(`prompt-registry: template uses undeclared var "{${v}}"`);
        }
      }
    }
    const entry = {
      id,
      version,
      template,
      hash: hashTemplate(template),
      vars: declaredVars || inferred,
      createdAt: Date.now(),
    };
    inner.set(version, entry);
    byId.set(id, inner);
    return entry;
  }

  function versions(id) {
    const inner = byId.get(id);
    if (!inner) return [];
    return [...inner.keys()].sort(compareSemver).reverse();
  }

  function get(id, version) {
    const inner = byId.get(id);
    if (!inner) return null;
    if (version) return inner.get(version) || null;
    const top = versions(id)[0];
    return top ? inner.get(top) : null;
  }

  function lineageFor(id, version) {
    const e = get(id, version);
    if (!e) return null;
    return { id: e.id, version: e.version, hash: e.hash };
  }

  function render(id, vars = {}, { version } = {}) {
    const entry = get(id, version);
    if (!entry) throw new Error(`prompt-registry: unknown template id="${id}"${version ? ` v${version}` : ''}`);
    let text = entry.template.replace(VAR_RE, (full, name) => {
      if (Object.prototype.hasOwnProperty.call(vars, name)) {
        const v = vars[name];
        return v == null ? '' : String(v);
      }
      // Leave placeholder intact when not supplied; lets a caller layer
      // a second render pass without us guessing.
      return full;
    });
    return { text, lineage: lineageFor(id, version) };
  }

  function list() {
    const out = [];
    for (const [id, inner] of byId) {
      for (const v of versions(id)) {
        const e = inner.get(v);
        out.push({ id, version: v, hash: e.hash, vars: [...e.vars], createdAt: e.createdAt });
      }
    }
    return out;
  }

  return { register, get, versions, render, lineageFor, list };
}

module.exports = {
  createPromptRegistry,
  hashTemplate,
  extractVars,
  parseSemver,
  compareSemver,
};
