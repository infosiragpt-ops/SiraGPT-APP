'use strict';

/**
 * provider-http-agent — shared undici dispatcher for outbound provider
 * calls (OpenAI, OpenRouter, Gemini, DeepSeek).
 *
 * Why this exists:
 *   The OpenAI SDK builds a fresh fetch invocation per request and, by
 *   default, opens a new TLS connection per call. On chat endpoints we
 *   pay 100–250 ms per request just to TLS-handshake — every token of
 *   that delay shows up in TTFB. Reusing a keep-alive pool drops TTFB
 *   measurably under load (warm pool: ~30 ms instead of ~180 ms).
 *
 *   undici's Agent supports HTTP/1.1 keep-alive (the OpenAI control plane
 *   is HTTP/1.1; their edge upgrades to H2 transparently when present).
 *   `keepAliveTimeout` is the idle window before we close — set to 30 s,
 *   matching the longest typical provider idle. `keepAliveMaxTimeout` is
 *   the absolute lifetime cap so we recycle long-lived sockets and avoid
 *   stale connections that intermediaries silently dropped.
 *
 *   `pipelining: 1` is intentional: Anthropic / OpenAI streaming responses
 *   make pipelining unsafe (the response is open-ended; a second request
 *   on the same socket would block until the first stream finishes). We
 *   want connection REUSE, not request multiplexing.
 *
 * Usage:
 *   const fetchWithPool = require('./provider-http-agent').sharedFetch;
 *   new OpenAI({ apiKey, fetch: fetchWithPool });
 */

const { Agent, fetch: undiciFetch } = require('undici');

const KEEP_ALIVE_TIMEOUT_MS = Number(process.env.PROVIDER_KEEPALIVE_MS) || 30_000;
const KEEP_ALIVE_MAX_MS = Number(process.env.PROVIDER_KEEPALIVE_MAX_MS) || 10 * 60_000;
const CONNECT_TIMEOUT_MS = Number(process.env.PROVIDER_CONNECT_TIMEOUT_MS) || 10_000;
const CONNECTIONS_PER_ORIGIN = Number(process.env.PROVIDER_POOL_SIZE) || 64;

let sharedAgent = null;

function getSharedAgent() {
  if (!sharedAgent) {
    sharedAgent = new Agent({
      keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
      keepAliveMaxTimeout: KEEP_ALIVE_MAX_MS,
      connect: { timeout: CONNECT_TIMEOUT_MS },
      pipelining: 1,
      connections: CONNECTIONS_PER_ORIGIN,
    });
  }
  return sharedAgent;
}

/**
 * Drop the shared agent so a fresh one is built on next use. Tests use
 * this to release sockets cleanly between cases. Production code should
 * not need to call it.
 */
async function destroySharedAgent() {
  if (sharedAgent) {
    const a = sharedAgent;
    sharedAgent = null;
    try { await a.close(); } catch { /* ignore */ }
  }
}

/**
 * fetch() that routes through the shared keep-alive pool. Drop-in for
 * the OpenAI SDK's `fetch` option.
 */
function sharedFetch(input, init = {}) {
  const dispatcher = init.dispatcher || getSharedAgent();
  return undiciFetch(input, { ...init, dispatcher });
}

module.exports = {
  getSharedAgent,
  destroySharedAgent,
  sharedFetch,
};
