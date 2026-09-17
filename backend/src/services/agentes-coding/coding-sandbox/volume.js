'use strict';

/**
 * Host-side durable workspace for docker / volume DEV drivers (Phase 4e).
 *
 * Bind-mount root is `{dataDir}/{sessionId}/workspace`. Path jail stays
 * the same `/workspace` contract. Injectable `fs` so CI never needs Docker.
 * Memory driver does not use this module.
 */

const os = require('node:os');
const path = require('node:path');
const defaultFs = require('node:fs');
const { fail } = require('./errors');
const { jailRelPath } = require('./path-jail');

const DEFAULT_DIR_NAME = 'siragpt-agentes-coding';
const META_FILE = 'meta.json';
const WORKSPACE_DIR = 'workspace';
const SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

const BLOCKED_DATA_PREFIXES = Object.freeze([
  '/etc', '/root', '/bin', '/sbin', '/usr', '/proc', '/sys', '/dev', '/boot', '/var/run',
]);

function sanitizeSessionId(id) {
  const raw = String(id || '').trim();
  if (!raw) fail('E_PARAMS', 'Falta sessionId.');
  if (!SESSION_ID_RE.test(raw)) fail('E_PATH_ESCAPE', 'sessionId inválido para el volumen.');
  return raw;
}

function assertSafeDataDir(resolved) {
  const n = path.resolve(resolved);
  if (!n || n === '/' || n === path.parse(n).root) {
    fail('E_PARAMS', 'El data dir del sandbox no es válido.');
  }
  const posix = n.replace(/\\/g, '/');
  for (const prefix of BLOCKED_DATA_PREFIXES) {
    if (posix === prefix || posix.startsWith(`${prefix}/`)) {
      fail('E_PARAMS', 'El data dir del sandbox no es válido.');
    }
  }
  return n;
}

function resolveDataDir(env = {}, opts = {}) {
  const raw = opts.dataDir
    || env.AGENTES_CODING_SANDBOX_DATA_DIR
    || path.join(os.tmpdir(), DEFAULT_DIR_NAME);
  const resolved = path.resolve(String(raw).trim() || path.join(os.tmpdir(), DEFAULT_DIR_NAME));
  if (opts.skipSafeDirCheck) return resolved;
  return assertSafeDataDir(resolved);
}

function assertInside(root, candidate) {
  const base = path.resolve(root);
  const abs = path.resolve(candidate);
  const rel = path.relative(base, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) fail('E_PATH_ESCAPE');
  return abs;
}

function wrapFs(fsLike) {
  const fs = fsLike || defaultFs;
  return {
    existsSync: (p) => (typeof fs.existsSync === 'function' ? fs.existsSync(p) : defaultFs.existsSync(p)),
    mkdirSync: (p, opts) => fs.mkdirSync(p, opts),
    writeFileSync: (p, data, opts) => fs.writeFileSync(p, data, opts),
    readFileSync: (p, opts) => fs.readFileSync(p, opts),
    rmSync: (p, opts) => {
      if (typeof fs.rmSync === 'function') return fs.rmSync(p, opts);
      if (typeof fs.rmdirSync === 'function') return fs.rmdirSync(p, opts);
    },
    readdirSync: (p, opts) => fs.readdirSync(p, opts),
    statSync: (p, opts) => fs.statSync(p, opts),
  };
}

function createSessionVolume(opts = {}) {
  const env = opts.env || process.env;
  const fs = wrapFs(opts.fs);
  const dataDir = resolveDataDir(env, {
    dataDir: opts.dataDir,
    skipSafeDirCheck: Boolean(opts.fs && opts.skipSafeDirCheck !== false && opts.dataDir),
  });

  function sessionDir(sessionId) {
    const id = sanitizeSessionId(sessionId);
    return assertInside(dataDir, path.join(dataDir, id));
  }

  function workspacePath(sessionId) {
    return assertInside(sessionDir(sessionId), path.join(sessionDir(sessionId), WORKSPACE_DIR));
  }

  function metaPath(sessionId) {
    return assertInside(sessionDir(sessionId), path.join(sessionDir(sessionId), META_FILE));
  }

  function hostFilePath(sessionId, relPath) {
    const rel = jailRelPath(relPath);
    const root = workspacePath(sessionId);
    return assertInside(root, path.join(root, rel));
  }

  function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o777 });
  }

  function exists(sessionId) {
    try {
      return fs.existsSync(sessionDir(sessionId));
    } catch (err) {
      if (err && err.code === 'E_PATH_ESCAPE') throw err;
      return false;
    }
  }

  function listIds() {
    if (!fs.existsSync(dataDir)) return [];
    let names;
    try {
      names = fs.readdirSync(dataDir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      try {
        if (SESSION_ID_RE.test(name) && fs.existsSync(metaPath(name))) out.push(name);
      } catch {
        /* skip alien entries */
      }
    }
    return out;
  }

  function walkFiles(sessionId, relDir = '.') {
    const prefix = jailRelPath(relDir, { forList: true });
    const root = workspacePath(sessionId);
    if (!fs.existsSync(root)) return [];
    const out = [];
    function walk(dir, rel) {
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const abs = path.join(dir, name);
        const childRel = rel ? `${rel}/${name}` : name;
        let st;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        if (st.isDirectory && st.isDirectory()) walk(abs, childRel);
        else if (!st.isDirectory || st.isFile()) {
          out.push({ path: childRel.replace(/\\/g, '/'), size: Number(st.size) || 0 });
        }
      }
    }
    walk(root, '');
    if (prefix === '.') {
      out.sort((a, b) => a.path.localeCompare(b.path));
      return out;
    }
    return out
      .filter((row) => row.path === prefix || row.path.startsWith(`${prefix}/`))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  function usage(sessionId) {
    const files = walkFiles(sessionId, '.');
    let bytes = 0;
    for (const row of files) bytes += row.size;
    return { files: files.length, bytes };
  }

  function assertCanWrite(session, relPath, nextBytes) {
    const limits = session && session.limits ? session.limits : {};
    const maxFiles = Number(limits.maxVolumeFiles) || 500;
    const maxBytes = Number(limits.maxVolumeBytes) || 256 * 1024 * 1024;
    const rel = jailRelPath(relPath);
    const current = usage(session.id);
    let replacing = 0;
    try {
      const abs = hostFilePath(session.id, rel);
      if (fs.existsSync(abs)) {
        const st = fs.statSync(abs);
        replacing = Number(st.size) || 0;
      }
    } catch {
      replacing = 0;
    }
    const nextCount = current.files + (replacing ? 0 : 1);
    const nextTotal = current.bytes - replacing + nextBytes;
    if (nextCount > maxFiles || nextTotal > maxBytes) {
      fail('E_QUOTA', 'El volumen de la sesión supera el tope.');
    }
  }

  function readMeta(sessionId) {
    const file = metaPath(sessionId);
    if (!fs.existsSync(file)) return null;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(String(raw || ''));
      if (!parsed || typeof parsed !== 'object' || parsed.id !== sessionId) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function saveMeta(session) {
    if (!session || !session.id) return null;
    ensureDir(sessionDir(session.id));
    const payload = {
      id: session.id,
      userId: session.userId || null,
      driver: session.driver || 'docker',
      image: session.image || null,
      createdAt: session.createdAt,
      lastTouched: session.lastTouched,
      expiresAt: session.expiresAt,
      limits: session.limits ? { ...session.limits } : {},
      network: {
        allowlist: session.network && Array.isArray(session.network.allowlist)
          ? [...session.network.allowlist]
          : [],
        portAllowlist: session.network && Array.isArray(session.network.portAllowlist)
          ? [...session.network.portAllowlist]
          : [],
      },
    };
    fs.writeFileSync(metaPath(session.id), `${JSON.stringify(payload)}\n`, 'utf8');
    return payload;
  }

  function ensure(session) {
    ensureDir(dataDir);
    ensureDir(workspacePath(session.id));
    saveMeta(session);
    return workspacePath(session.id);
  }

  function readFile(sessionId, relPath) {
    const abs = hostFilePath(sessionId, relPath);
    if (!fs.existsSync(abs)) fail('E_PARAMS', `No existe ${jailRelPath(relPath)}.`);
    const buf = fs.readFileSync(abs);
    return Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''), 'utf8');
  }

  function writeFile(sessionId, relPath, content) {
    const rel = jailRelPath(relPath);
    const abs = hostFilePath(sessionId, rel);
    ensureDir(path.dirname(abs));
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    fs.writeFileSync(abs, buf);
    return { path: rel, bytes: buf.length };
  }

  function remove(sessionId) {
    if (!exists(sessionId)) return false;
    const dir = sessionDir(sessionId);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return false;
      throw err;
    }
    return true;
  }

  return {
    kind: 'volume',
    dataDir,
    sanitizeSessionId,
    sessionDir,
    workspacePath,
    hostFilePath,
    exists,
    listIds,
    walkFiles,
    usage,
    assertCanWrite,
    readMeta,
    saveMeta,
    ensure,
    readFile,
    writeFile,
    remove,
  };
}

function createMapFs() {
  const files = new Map();
  const norm = (p) => path.resolve(String(p));
  function ensureParents(abs) {
    let cur = path.dirname(abs);
    const root = path.parse(abs).root || '/';
    while (cur && cur !== root) {
      const existing = files.get(cur);
      if (!existing) files.set(cur, { dir: true });
      cur = path.dirname(cur);
    }
    if (root) files.set(root, { dir: true });
  }
  return {
    existsSync(p) {
      return files.has(norm(p));
    },
    mkdirSync(p) {
      const abs = norm(p);
      ensureParents(abs);
      files.set(abs, { dir: true });
    },
    writeFileSync(p, data) {
      const abs = norm(p);
      ensureParents(abs);
      files.set(abs, Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
    },
    readFileSync(p, encoding) {
      const v = files.get(norm(p));
      if (!v || v.dir) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return encoding ? v.toString(encoding) : Buffer.from(v);
    },
    rmSync(p, opts) {
      const abs = norm(p);
      if (opts && opts.recursive) {
        for (const key of [...files.keys()]) {
          if (key === abs || key.startsWith(`${abs}${path.sep}`)) files.delete(key);
        }
        return;
      }
      files.delete(abs);
    },
    readdirSync(p) {
      const abs = norm(p);
      const prefix = `${abs}${path.sep}`;
      const names = new Set();
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const name = rest.split(path.sep)[0];
          if (name) names.add(name);
        }
      }
      return [...names];
    },
    statSync(p) {
      const v = files.get(norm(p));
      if (!v) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return {
        isDirectory: () => Boolean(v.dir),
        isFile: () => !v.dir,
        size: v.dir ? 0 : v.length,
      };
    },
  };
}

module.exports = {
  DEFAULT_DIR_NAME,
  META_FILE,
  WORKSPACE_DIR,
  sanitizeSessionId,
  resolveDataDir,
  assertSafeDataDir,
  createSessionVolume,
  createMapFs,
};
