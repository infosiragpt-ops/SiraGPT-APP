'use strict';

/**
 * closeHttpServer — make `server.close()` finish inside the shutdown budget.
 *
 * `server.close()` only stops accepting NEW connections; it resolves once
 * every existing socket has gone away. This process keeps keep-alive
 * sockets open for 2 minutes (index.js sets `keepAliveTimeout = 120 s` for
 * the Next.js proxy) and serves SSE streams that stay open for the whole
 * chat turn, so in production the `http_server_close` step never finished
 * and every SIGTERM burned its full 5 s budget before the remaining steps
 * ran (prod 2026-10-03, three restarts).
 *
 * Sequence: close the listener → drop idle keep-alive sockets right away →
 * give in-flight requests `graceMs` to finish → cut whatever is still open
 * (SSE / long polls; the client reconnects to the new process) → resolve.
 * Never rejects; `onCut(count)` reports how many sockets were cut.
 */

const DEFAULT_GRACE_MS = 3500;

function graceFromEnv(env = process.env) {
  const raw = Number(env.SIRAGPT_HTTP_CLOSE_GRACE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_GRACE_MS;
}

function closeHttpServer(server, { graceMs = graceFromEnv(), onCut, setTimeoutImpl = setTimeout } = {}) {
  return new Promise((resolve) => {
    if (!server || typeof server.close !== 'function') return resolve({ closed: false, cut: 0 });
    let settled = false;
    let timer = null;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer && typeof clearTimeout === 'function') clearTimeout(timer);
      resolve(outcome);
    };
    const countOpen = () => new Promise((done) => {
      if (typeof server.getConnections !== 'function') return done(0);
      server.getConnections((err, count) => done(err ? 0 : Number(count) || 0));
    });

    try {
      server.close(() => finish({ closed: true, cut: 0 }));
    } catch (_) {
      return finish({ closed: false, cut: 0 });
    }
    try { if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections(); } catch (_) { /* best effort */ }

    timer = setTimeoutImpl(async () => {
      if (settled) return;
      const open = await countOpen();
      try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections(); } catch (_) { /* best effort */ }
      if (open > 0 && typeof onCut === 'function') {
        try { onCut(open); } catch (_) { /* never throw from a reporter */ }
      }
      finish({ closed: true, cut: open });
    }, graceMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}

module.exports = { closeHttpServer, DEFAULT_GRACE_MS, graceFromEnv };
