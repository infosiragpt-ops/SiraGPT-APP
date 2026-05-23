'use strict';

/**
 * compression — Negotiated brotli/gzip compression for JSON and SSE.
 *
 * Behavior:
 *   - Parses `Accept-Encoding` (with q-values + `*` wildcard) and selects
 *     the best encoding allowed for the route. Brotli is preferred for
 *     buffered responses (JSON/text/HTML); SSE is gzip by default, but
 *     can opt into brotli streaming via the `sseBrotli` option (or env
 *     `SIRAGPT_SSE_BROTLI=1`). When enabled, brotli streams flush each
 *     frame using BROTLI_OPERATION_FLUSH at a low quality (default 1)
 *     to keep per-frame latency low.
 *   - For non-SSE responses, body bytes are buffered until res.end(), then
 *     compressed only if the total payload meets `threshold` (default
 *     1 KiB). Below-threshold responses pass through uncompressed.
 *   - For SSE (`text/event-stream`), each chunk is compressed and flushed
 *     per frame (Z_SYNC_FLUSH for gzip, BROTLI_OPERATION_FLUSH for br)
 *     so events are delivered as soon as they are written.
 *   - Bypasses compression for content types that are already compressed
 *     (image/*, video/*, audio/*, zip, gzip, brotli, pdf, octet-stream)
 *     and when the response already carries a `Content-Encoding` header.
 *   - Strips `Content-Length` and appends `Accept-Encoding` to `Vary`
 *     when compression is applied. Strong ETags are weakened (`W/...`).
 *   - A lightweight metrics registry tracks bytes_in / bytes_out per
 *     encoding plus skipped (below-threshold) totals.
 *
 * The middleware never throws into the request pipeline: any zlib error
 * is forwarded via `next(err)` so the upstream error handler can deal
 * with it without leaking a partial body.
 */

const zlib = require('node:zlib');

const DEFAULT_THRESHOLD = 1024;

// Content-types we should never re-compress. Matched as substring (case-insensitive).
const ALREADY_COMPRESSED = [
  /^image\//i,
  /^video\//i,
  /^audio\//i,
  /^application\/zip\b/i,
  /^application\/gzip\b/i,
  /^application\/x-gzip\b/i,
  /^application\/x-br\b/i,
  /^application\/x-brotli\b/i,
  /^application\/x-7z-compressed\b/i,
  /^application\/x-rar-compressed\b/i,
  /^application\/x-bzip2?\b/i,
  /^application\/octet-stream\b/i,
  /^application\/pdf\b/i,
  /\+zip\b/i,
  /\+gzip\b/i,
];

// ─── Accept-Encoding parsing ────────────────────────────────────────────────

function parseAcceptEncoding(header) {
  if (!header || typeof header !== 'string') return [];
  const out = [];
  for (const raw of header.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const [nameRaw, ...params] = part.split(';').map(s => s.trim());
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

/**
 * Select best encoding from `allowed` that the client accepts. `allowed`
 * is in server-priority order (first entry wins on tie). Honors q=0 as
 * "explicitly disallowed". Returns null if nothing matches.
 */
function selectEncoding(acceptHeader, allowed) {
  const list = parseAcceptEncoding(acceptHeader);
  if (list.length === 0) return null;

  // Build q lookup. A specific entry overrides `*` for the same name.
  const explicit = new Map();
  let wildcardQ = null;
  for (const e of list) {
    if (e.name === '*') {
      wildcardQ = e.q;
    } else {
      explicit.set(e.name, e.q);
    }
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

// ─── Metrics ────────────────────────────────────────────────────────────────

function createMetrics() {
  const state = {
    encodings: Object.create(null), // { gzip: { count, bytesIn, bytesOut }, ... }
    skipped: { count: 0, bytes: 0 },
    bypassed: { count: 0 },
  };

  function record(encoding, bytesIn, bytesOut) {
    let slot = state.encodings[encoding];
    if (!slot) {
      slot = state.encodings[encoding] = { count: 0, bytesIn: 0, bytesOut: 0 };
    }
    slot.count += 1;
    slot.bytesIn += bytesIn;
    slot.bytesOut += bytesOut;
  }

  function recordSkipped(bytes) {
    state.skipped.count += 1;
    state.skipped.bytes += bytes;
  }

  function recordBypassed() {
    state.bypassed.count += 1;
  }

  function snapshot() {
    const encodings = {};
    for (const [k, v] of Object.entries(state.encodings)) {
      encodings[k] = {
        count: v.count,
        bytesIn: v.bytesIn,
        bytesOut: v.bytesOut,
        ratio: v.bytesIn > 0 ? v.bytesOut / v.bytesIn : null,
      };
    }
    return {
      encodings,
      skipped: { ...state.skipped },
      bypassed: { ...state.bypassed },
    };
  }

  function reset() {
    state.encodings = Object.create(null);
    state.skipped = { count: 0, bytes: 0 };
    state.bypassed = { count: 0 };
  }

  return { record, recordSkipped, recordBypassed, snapshot, reset };
}

const globalMetrics = createMetrics();

// ─── Filter helpers ─────────────────────────────────────────────────────────

function defaultFilter(req, res, contentType) {
  if (!contentType) return false;
  for (const re of ALREADY_COMPRESSED) {
    if (re.test(contentType)) return false;
  }
  return true;
}

// ─── Middleware ─────────────────────────────────────────────────────────────

function envFlagEnabled(name) {
  const v = process.env[name];
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function compression(opts = {}) {
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : DEFAULT_THRESHOLD;
  const filter = typeof opts.filter === 'function' ? opts.filter : defaultFilter;
  const metrics = opts.metrics || globalMetrics;
  const brotliOptions = opts.brotliOptions || {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 4, // balance speed/ratio
    },
  };
  const gzipOptions = opts.gzipOptions || { level: 6 };

  // Streaming brotli for SSE — opt-in. Quality is kept low (default 1) to
  // minimize per-frame CPU overhead, since each frame is flushed.
  const sseBrotli = opts.sseBrotli != null
    ? Boolean(opts.sseBrotli)
    : envFlagEnabled('SIRAGPT_SSE_BROTLI');
  const sseBrotliOptions = opts.sseBrotliOptions || {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: Number.isFinite(opts.sseBrotliQuality)
        ? opts.sseBrotliQuality
        : 1,
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
    },
  };

  return function compressionMiddleware(req, res, next) {
    // Allow per-request opt-out.
    if (res.locals && res.locals.skipCompression === true) {
      return next();
    }

    const acceptEncoding = req.headers && req.headers['accept-encoding'];
    if (!acceptEncoding) {
      return next();
    }

    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);

    let decided = false;
    let bypass = false;
    let stream = null;
    let chosenEncoding = null;
    let isSSE = false;
    let bytesIn = 0;
    let bytesOut = 0;
    const buffered = [];
    let streaming = false; // true once SSE compression has started

    function decide() {
      if (decided) return;
      decided = true;

      // Already-encoded responses (e.g. file proxy) — leave alone.
      if (res.getHeader('content-encoding')) {
        bypass = true;
        metrics.recordBypassed();
        return;
      }

      const contentType = String(res.getHeader('content-type') || '');

      if (!filter(req, res, contentType)) {
        bypass = true;
        metrics.recordBypassed();
        return;
      }

      isSSE = /text\/event-stream/i.test(contentType);
      const allowed = isSSE
        ? (sseBrotli ? ['br', 'gzip'] : ['gzip'])
        : ['br', 'gzip'];
      chosenEncoding = selectEncoding(acceptEncoding, allowed);

      if (!chosenEncoding) {
        bypass = true;
        metrics.recordBypassed();
        return;
      }
    }

    function setCompressionHeaders() {
      res.setHeader('Content-Encoding', chosenEncoding);
      res.removeHeader('Content-Length');

      // Weaken strong ETags — compressed body has different bytes.
      const etag = res.getHeader('etag');
      if (typeof etag === 'string' && etag.length > 0 && !etag.startsWith('W/')) {
        res.setHeader('ETag', 'W/' + etag);
      }

      // Append Accept-Encoding to Vary.
      const vary = res.getHeader('vary');
      const varyStr = Array.isArray(vary) ? vary.join(', ') : (vary ? String(vary) : '');
      if (!/\baccept-encoding\b/i.test(varyStr)) {
        res.setHeader('Vary', varyStr ? varyStr + ', Accept-Encoding' : 'Accept-Encoding');
      }
    }

    function makeStream() {
      let s;
      if (chosenEncoding === 'br') {
        s = zlib.createBrotliCompress(isSSE ? sseBrotliOptions : brotliOptions);
      } else {
        s = zlib.createGzip(gzipOptions);
      }

      s.on('data', chunk => {
        bytesOut += chunk.length;
        origWrite(chunk);
      });
      s.on('error', err => {
        // Don't double-end; just forward the error.
        try { next(err); } catch (_) { /* noop */ }
      });
      s.on('end', () => {
        metrics.record(chosenEncoding, bytesIn, bytesOut);
        origEnd();
      });
      return s;
    }

    function toBuffer(chunk, encoding) {
      if (chunk == null) return null;
      if (Buffer.isBuffer(chunk)) return chunk;
      if (typeof chunk === 'string') return Buffer.from(chunk, encoding || 'utf8');
      // Uint8Array, etc.
      try { return Buffer.from(chunk); } catch (_) { return null; }
    }

    res.write = function patchedWrite(chunk, encoding, cb) {
      if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
      if (chunk == null || chunk.length === 0) {
        return origWrite(chunk, encoding, cb);
      }

      decide();

      if (bypass) {
        return origWrite(chunk, encoding, cb);
      }

      const buf = toBuffer(chunk, encoding);
      if (!buf) return origWrite(chunk, encoding, cb);
      bytesIn += buf.length;

      if (isSSE) {
        if (!streaming) {
          setCompressionHeaders();
          stream = makeStream();
          streaming = true;
        }
        const ok = stream.write(buf);
        // Flush per frame so SSE clients see events promptly. Brotli uses
        // BROTLI_OPERATION_FLUSH; gzip uses Z_SYNC_FLUSH.
        const flushOp = chosenEncoding === 'br'
          ? zlib.constants.BROTLI_OPERATION_FLUSH
          : zlib.constants.Z_SYNC_FLUSH;
        stream.flush(flushOp, () => { if (cb) cb(); });
        return ok;
      }

      // Buffered path — accumulate, decide at end().
      buffered.push(buf);
      if (cb) process.nextTick(cb);
      return true;
    };

    res.end = function patchedEnd(chunk, encoding, cb) {
      if (typeof chunk === 'function') { cb = chunk; chunk = undefined; encoding = undefined; }
      else if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }

      decide();

      if (bypass) {
        return origEnd(chunk, encoding, cb);
      }

      let tailBuf = null;
      if (chunk != null && chunk.length !== 0) {
        tailBuf = toBuffer(chunk, encoding);
        if (tailBuf) bytesIn += tailBuf.length;
      }

      if (isSSE) {
        if (!streaming) {
          // No body was written; nothing to compress meaningfully.
          // Emit empty body and skip compression headers.
          metrics.recordSkipped(0);
          return origEnd(chunk, encoding, cb);
        }
        if (tailBuf) stream.write(tailBuf);
        if (cb) stream.once('end', cb);
        return stream.end();
      }

      // Buffered (JSON/text/HTML) path.
      if (tailBuf) buffered.push(tailBuf);
      const total = buffered.length === 0
        ? Buffer.alloc(0)
        : (buffered.length === 1 ? buffered[0] : Buffer.concat(buffered));

      if (total.length < threshold) {
        metrics.recordSkipped(total.length);
        if (total.length > 0) {
          // Restore original Content-Length for accurate framing.
          if (!res.getHeader('content-length')) {
            res.setHeader('Content-Length', String(total.length));
          }
          origWrite(total);
        }
        return origEnd(cb);
      }

      setCompressionHeaders();
      stream = makeStream();
      if (cb) stream.once('end', cb);
      stream.end(total);
    };

    next();
  };
}

module.exports = {
  compression,
  parseAcceptEncoding,
  selectEncoding,
  createMetrics,
  metrics: globalMetrics,
  ALREADY_COMPRESSED,
  DEFAULT_THRESHOLD,
};
