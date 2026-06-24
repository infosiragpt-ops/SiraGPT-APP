#!/usr/bin/env node
'use strict';

/**
 * smoke.js — validate a DEPLOYED sandbox service end to end.
 *
 *   SANDBOX_SERVICE_URL=https://sandbox.chatagic.com SANDBOX_API_KEY=... \
 *     node scripts/smoke.js
 *
 * Checks: /health is public + reports docker; a protected endpoint is 401
 * without the key and works with it; a session round-trip (create → write →
 * exec → read → destroy) succeeds. Exit 0 on success.
 */

const BASE = String(process.env.SANDBOX_SERVICE_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
const KEY = process.env.SANDBOX_API_KEY || '';

async function main() {
  if (!KEY) throw new Error('SANDBOX_API_KEY is required');
  const auth = { Authorization: `Bearer ${KEY}` };

  const health = await fetch(`${BASE}/health`);
  const hj = await health.json();
  console.log(`/health → ${health.status} docker=${hj.docker} active=${hj.activeSessions}/${hj.maxConcurrency}`);
  if (health.status !== 200 || !hj.ok) throw new Error('health failed');

  const noKey = await fetch(`${BASE}/v1/sessions`, { method: 'POST' });
  console.log(`POST /v1/sessions (no key) → ${noKey.status} (expect 401)`);
  if (noKey.status !== 401) throw new Error('auth not enforced');

  const create = await fetch(`${BASE}/v1/sessions`, { method: 'POST', headers: auth });
  console.log(`POST /v1/sessions (key) → ${create.status} (expect 201)`);
  if (create.status !== 201) throw new Error(`session create failed: ${await create.text()}`);
  const { sessionId } = await create.json();

  try {
    const post = (p, body) => fetch(`${BASE}/v1/sessions/${sessionId}${p}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await post('/write', { path: 'outputs/hi.txt', contentBase64: Buffer.from('hola sandbox').toString('base64') });
    const ex = await (await post('/exec', { command: 'cat /workspace/outputs/hi.txt && python3 --version && libreoffice --version 2>/dev/null | head -1' })).json();
    console.log(`exec stdout: ${String(ex.stdout || '').replace(/\n/g, ' | ').slice(0, 160)}`);
    const read = await (await post('/read', { path: 'outputs/hi.txt' })).json();
    const got = Buffer.from(read.contentBase64, 'base64').toString();
    console.log(`round-trip read: ${JSON.stringify(got)}`);
    if (got !== 'hola sandbox') throw new Error('round-trip mismatch');
  } finally {
    await fetch(`${BASE}/v1/sessions/${sessionId}`, { method: 'DELETE', headers: auth });
  }
  console.log('SMOKE PASS ✅');
}

main().catch((e) => { console.error('SMOKE FAIL ❌', e.message); process.exit(1); });
