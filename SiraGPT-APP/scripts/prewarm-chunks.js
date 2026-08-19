#!/usr/bin/env node
/**
 * Prewarms Next.js on-demand chunks that are compiled lazily and timeout
 * through the Replit dev proxy on first access (e.g. app/global-error.js).
 *
 * Run in the background right after the frontend starts. Polls until
 * Next.js answers 200 on /, then fetches each target SEQUENTIALLY so
 * Next.js's single-threaded webpack compiler never gets more than one
 * concurrent compilation request (parallel requests cause all pages to
 * timeout when the compiler deadlocks).
 *
 * Order: most user-critical pages first, then JS chunks, then API routes.
 */
'use strict';

const http = require('node:http');

const PORT = process.env.FRONTEND_PORT || 3000;
const MAX_WAIT_MS = 180_000;
const POLL_MS = 3_000;
const CHUNK_FETCH_DELAY_MS = 5_000;

// Fetched SEQUENTIALLY — keep /auth/login first (most critical).
const TARGETS = [
  // Most critical: the first client-side navigation users make.
  // Pre-compiling this eliminates the "Load failed" RSC TypeError.
  '/auth/login',
  // Secondary auth pages
  '/auth/register',
  // JS chunks — already compiled after / loads, returns 200 instantly
  '/_next/static/chunks/app/global-error.js',
  // sentry-client-init: ssr:false dynamic(), compiles lazily on first browser render
  '/_next/static/chunks/_app-pages-browser_components_sentry-client-init_tsx.js',
  // Backend health route: compile it early so useBackendReady gets fast responses
  '/api/health/ready',
];

function get(path, timeoutMs = 35_000) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: 'localhost', port: PORT, path, headers: { 'user-agent': 'prewarm/1.0' } },
      (res) => { res.resume(); resolve(res.statusCode); },
    );
    req.on('error', (err) => { resolve(null); });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}

async function waitForNextJs() {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const status = await get('/', 8_000);
    if (status === 200) return true;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return false;
}

async function main() {
  process.stdout.write('[prewarm] waiting for Next.js on port ' + PORT + '…\n');
  const ready = await waitForNextJs();
  if (!ready) {
    process.stdout.write('[prewarm] Next.js did not become ready — skipping chunk pre-warm\n');
    return;
  }
  process.stdout.write('[prewarm] Next.js ready — waiting ' + (CHUNK_FETCH_DELAY_MS / 1000) + 's for initial compilation to settle…\n');
  await new Promise((r) => setTimeout(r, CHUNK_FETCH_DELAY_MS));

  // Sequential: one at a time to avoid overwhelming Next.js webpack compiler.
  for (const target of TARGETS) {
    const status = await get(target, 35_000);
    process.stdout.write('[prewarm] ' + target + ' → ' + (status !== null ? status : 'error') + '\n');
  }
  process.stdout.write('[prewarm] done\n');
}

main().catch((err) => {
  process.stdout.write('[prewarm] error: ' + (err?.message || err) + '\n');
});
