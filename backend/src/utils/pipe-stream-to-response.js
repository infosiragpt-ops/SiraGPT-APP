'use strict';

/**
 * pipeStreamToResponse — pipe a readable stream to an Express response with an
 * 'error' listener attached BEFORE piping.
 *
 * Why this exists: a source stream (an R2/S3 object body, or
 * `fs.createReadStream` of a cache file another route can unlink mid-stream)
 * can emit 'error' asynchronously. A bare `stream.pipe(res)` attaches no error
 * listener, so Node treats that 'error' as unhandled — which the process-level
 * `uncaughtException` handler turns into `process.exit(1)`, crashing the whole
 * backend over a single failed download. Attaching the listener first contains
 * the failure to that one response.
 *
 * On error: respond 500 if nothing has been flushed yet (`res.headersSent`
 * false), otherwise destroy the now-truncated response. Mirrors the inline
 * convention in static-precompressed.js / elevenlabs.js.
 *
 * @param {import('stream').Readable} stream  source readable stream
 * @param {import('http').ServerResponse} res Express/Node response
 * @param {string} [label] short tag for the error log line
 * @returns {import('http').ServerResponse} the piped response
 */
function pipeStreamToResponse(stream, res, label) {
  stream.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error(`[pipe-stream] stream error${label ? ` (${label})` : ''}:`, (err && err.message) || err);
    if (!res.headersSent) {
      try {
        res.status(500).json({ error: 'Stream error' });
      } catch (_e) { /* response already torn down */ }
    } else {
      try { res.destroy(err); } catch (_e) { /* noop */ }
    }
  });
  return stream.pipe(res);
}

module.exports = { pipeStreamToResponse };
