'use strict';

/**
 * static-precompressed — Serve pre-compressed sibling assets (.br / .gz)
 * from a static root when the client's Accept-Encoding allows.
 *
 * Behavior:
 *   - GET/HEAD only. Other methods fall through to next().
 *   - Resolves the candidate path under `root`, rejecting traversal.
 *   - Negotiates encoding via Accept-Encoding (q-values, `*` wildcard,
 *     q=0 disallow). Server priority: brotli first, then gzip.
 *   - For each acceptable encoding, looks for `<file>.br` / `<file>.gz`
 *     on disk. If found, streams it with:
 *       Content-Encoding: <encoding>
 *       Content-Type: <inferred from original extension>
 *       Content-Length: <size of precompressed file>
 *       Vary: Accept-Encoding (appended)
 *   - Never compresses on the fly — that is `compression.js`'s job. This
 *     module only serves precomputed artifacts.
 *   - On HEAD, body is omitted but headers still reflect the chosen
 *     encoding's size.
 *   - On any FS error before headers are sent, falls through to next()
 *     so the regular static handler can take over.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ENCODINGS = ['br', 'gzip'];
const EXTENSION_BY_ENCODING = Object.freeze({ br: '.br', gzip: '.gz' });

const MIME_BY_EXT = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
});

function inferContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

// ─── Accept-Encoding parsing (small, local — no dependency on compression.js) ─

function parseAcceptEncoding(header) {
  if (!header || typeof header !== 'string') return [];
  const out = [];
  for (const raw of header.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const [nameRaw, ...params] = part.split(';').map((s) => s.trim());
    const name = nameRaw.toLowerCase();
    let q = 1;
    for (const p of params) {
      const m = /^q=([\d.]+)$/i.exec(p);
      if (m) {
        const v = parseFloat(m[1]);
        if (Number.isFinite(v)) q = v;
      }
    }
    if (q < 0) q = 0;
    out.push({ name, q });
  }
  return out;
}

function selectEncoding(acceptHeader, allowed) {
  const list = parseAcceptEncoding(acceptHeader);
  if (list.length === 0) return null;

  const explicit = new Map();
  let wildcardQ = null;
  for (const e of list) {
    if (e.name === '*') wildcardQ = e.q;
    else explicit.set(e.name, e.q);
  }

  let best = null;
  for (let i = 0; i < allowed.length; i++) {
    const name = allowed[i];
    let q;
    if (explicit.has(name)) q = explicit.get(name);
    else if (wildcardQ != null) q = wildcardQ;
    else continue;
    if (q <= 0) continue;
    if (best == null || q > best.q || (q === best.q && i < best.idx)) {
      best = { name, q, idx: i };
    }
  }
  return best ? best.name : null;
}

// ─── Path resolution ────────────────────────────────────────────────────────

function resolveSafePath(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath || '/');
  } catch (_e) {
    return null;
  }
  if (decoded.indexOf('\0') !== -1) return null;

  const queryIdx = decoded.indexOf('?');
  if (queryIdx !== -1) decoded = decoded.slice(0, queryIdx);
  const hashIdx = decoded.indexOf('#');
  if (hashIdx !== -1) decoded = decoded.slice(0, hashIdx);

  // Strip leading slash so path.join doesn't anchor outside root.
  const rel = decoded.replace(/^\/+/, '');
  const joined = path.join(root, rel);
  const rootResolved = path.resolve(root);
  const target = path.resolve(joined);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    return null;
  }
  return target;
}

// ─── Async fs helpers (small and explicit — no dep on fs/promises) ──────────

function statIfExists(p) {
  return new Promise((resolve) => {
    fs.stat(p, (err, st) => {
      if (err) return resolve(null);
      resolve(st);
    });
  });
}

// ─── Middleware ─────────────────────────────────────────────────────────────

function servePrecompressed(opts = {}) {
  if (!opts || typeof opts.root !== 'string' || opts.root.length === 0) {
    throw new TypeError('servePrecompressed: `root` is required');
  }
  const root = path.resolve(opts.root);
  const encodings = Array.isArray(opts.encodings) && opts.encodings.length > 0
    ? opts.encodings.slice()
    : DEFAULT_ENCODINGS.slice();
  for (const enc of encodings) {
    if (!EXTENSION_BY_ENCODING[enc]) {
      throw new TypeError(`servePrecompressed: unsupported encoding "${enc}"`);
    }
  }
  const setHeaders = typeof opts.setHeaders === 'function' ? opts.setHeaders : null;

  return async function precompressedMiddleware(req, res, next) {
    try {
      const method = req.method;
      if (method !== 'GET' && method !== 'HEAD') return next();

      // Already-decided encoding upstream — don't override.
      if (res.getHeader && res.getHeader('content-encoding')) return next();

      const acceptEncoding = req.headers && req.headers['accept-encoding'];
      const chosen = selectEncoding(acceptEncoding, encodings);
      if (!chosen) return next();

      // Path comes from req.path (mount-stripped) when available.
      const urlPath = (req.path != null) ? req.path : (req.url || '/');
      const basePath = resolveSafePath(root, urlPath);
      if (!basePath) return next();

      // The original file must also exist (don't serve a stray .br whose
      // source has been deleted — that would surface a 404 elsewhere).
      const baseStat = await statIfExists(basePath);
      if (!baseStat || !baseStat.isFile()) return next();

      const ext = EXTENSION_BY_ENCODING[chosen];
      const compressedPath = basePath + ext;
      const compStat = await statIfExists(compressedPath);
      if (!compStat || !compStat.isFile()) return next();

      const contentType = inferContentType(basePath);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Encoding', chosen);
      res.setHeader('Content-Length', String(compStat.size));

      // Append Accept-Encoding to Vary.
      const vary = res.getHeader('vary');
      const varyStr = Array.isArray(vary) ? vary.join(', ') : (vary ? String(vary) : '');
      if (!/\baccept-encoding\b/i.test(varyStr)) {
        res.setHeader('Vary', varyStr ? varyStr + ', Accept-Encoding' : 'Accept-Encoding');
      }

      // Weak ETag tied to the compressed artifact (size + mtime).
      const etag = 'W/"' + compStat.size.toString(16) + '-' + Math.floor(compStat.mtimeMs).toString(16) + '"';
      res.setHeader('ETag', etag);

      if (setHeaders) {
        try { setHeaders(res, basePath, { encoding: chosen, compressedPath, stat: compStat }); }
        catch (_e) { /* user hook errors must not break the response */ }
      }

      // Conditional GET — match the weak ETag.
      const ifNoneMatch = req.headers && req.headers['if-none-match'];
      if (ifNoneMatch && ifNoneMatch === etag) {
        res.statusCode = 304;
        return res.end();
      }

      if (method === 'HEAD') {
        return res.end();
      }

      const stream = fs.createReadStream(compressedPath);
      stream.on('error', (err) => {
        if (!res.headersSent) {
          // Drop the partially-set headers so the next handler is free.
          try {
            res.removeHeader('Content-Encoding');
            res.removeHeader('Content-Length');
            res.removeHeader('ETag');
          } catch (_e) { /* noop */ }
          return next(err);
        }
        try { res.destroy(err); } catch (_e) { /* noop */ }
      });
      stream.pipe(res);
    } catch (err) {
      if (!res.headersSent) return next(err);
      try { res.destroy(err); } catch (_e) { /* noop */ }
    }
  };
}

module.exports = {
  servePrecompressed,
  parseAcceptEncoding,
  selectEncoding,
  inferContentType,
  resolveSafePath,
  EXTENSION_BY_ENCODING,
  DEFAULT_ENCODINGS,
};
