#!/usr/bin/env node
/**
 * Prewarms Next.js on-demand chunks that are compiled lazily and timeout
 * through the Replit dev proxy on first access (e.g. app/global-error.js).
 *
 * Run in the background right after the frontend starts. Polls until
 * Next.js answers 200 on /, then fetches each chunk so the compiler
 * pre-builds it before the browser ever needs it.
 */
'use strict';

const http = require('node:http');

const PORT = process.env.FRONTEND_PORT || 3000;
const MAX_WAIT_MS = 180_000;
const POLL_MS = 3_000;
const CHUNK_FETCH_DELAY_MS = 5_000;

const CHUNKS = [
  '/_next/static/chunks/app/global-error.js',
];

function get(path, timeoutMs = 8_000) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: 'localhost', port: PORT, path, headers: { 'user-agent': 'prewarm/1.0' } },
      (res) => { res.resume(); resolve(res.statusCode); },
    );
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}

async function waitForNextJs() {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const status = await get('/');
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

  for (const chunk of CHUNKS) {
    const status = await get(chunk, 30_000);
    process.stdout.write('[prewarm] ' + chunk + ' → ' + (status || 'error') + '\n');
  }
  process.stdout.write('[prewarm] done\n');
}

main().catch((err) => {
  process.stdout.write('[prewarm] error: ' + (err?.message || err) + '\n');
});
