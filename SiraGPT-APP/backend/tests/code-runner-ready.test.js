'use strict';

// Readiness hardening for the host-runner: a dev server that is "listening"
// but serving a 5xx or a Next/Vite compile-error overlay must NOT be reported
// as ready. hasErrorOverlay + strict probeReady close that false-ready hole.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const hr = require('../src/services/code/host-runner');

const NEXT_OVERLAY = '<html><body><nextjs-portal></nextjs-portal><script>__NEXT_ERROR</script>Failed to compile</body></html>';
const VITE_OVERLAY = '<html><vite-error-overlay></vite-error-overlay></html>';
const CLEAN = '<!DOCTYPE html><html><head><title>My App</title></head><body><div id="root">Hello</div></body></html>';

test('hasErrorOverlay detects Next.js + Vite error screens', () => {
  assert.equal(hr.hasErrorOverlay(NEXT_OVERLAY), true);
  assert.equal(hr.hasErrorOverlay(VITE_OVERLAY), true);
  assert.equal(hr.hasErrorOverlay('Module not found: Can\'t resolve "x"'), true);
});

test('hasErrorOverlay: clean HTML / empty is not an error', () => {
  assert.equal(hr.hasErrorOverlay(CLEAN), false);
  assert.equal(hr.hasErrorOverlay(''), false);
  assert.equal(hr.hasErrorOverlay(null), false);
});

test('strictReadyEnabled: default on, kill-switch off', () => {
  delete process.env.CODE_RUNNER_STRICT_READY;
  assert.equal(hr.strictReadyEnabled(), true);
  process.env.CODE_RUNNER_STRICT_READY = '0';
  assert.equal(hr.strictReadyEnabled(), false);
  delete process.env.CODE_RUNNER_STRICT_READY;
});

// ── probeReady with an injected global fetch ───────────────────
let realFetch;
beforeEach(() => { realFetch = global.fetch; delete process.env.CODE_RUNNER_STRICT_READY; });
afterEach(() => { global.fetch = realFetch; delete process.env.CODE_RUNNER_STRICT_READY; });

const fakeRes = (status, body) => ({ status, text: async () => body });
const readyRun = () => ({ stopped: false, phase: 'ready' });

test('probeReady: 2xx clean page → ready (resolves)', async () => {
  global.fetch = async () => fakeRes(200, CLEAN);
  await assert.doesNotReject(() => hr.probeReady(1234, '/', Date.now() + 5000, readyRun()));
});

test('probeReady: 4xx (server up, no overlay) → ready', async () => {
  global.fetch = async () => fakeRes(404, 'Not Found');
  await assert.doesNotReject(() => hr.probeReady(1234, '/', Date.now() + 5000, readyRun()));
});

test('probeReady strict: compile-error overlay → throws', async () => {
  global.fetch = async () => fakeRes(200, NEXT_OVERLAY);
  await assert.rejects(() => hr.probeReady(1234, '/', Date.now() + 50, readyRun()), /errores/);
});

test('probeReady strict: 5xx → throws with status', async () => {
  global.fetch = async () => fakeRes(500, 'Internal Error');
  await assert.rejects(() => hr.probeReady(1234, '/', Date.now() + 50, readyRun()), /HTTP 500/);
});

test('probeReady legacy (strict off): 5xx → ready (any response)', async () => {
  process.env.CODE_RUNNER_STRICT_READY = '0';
  global.fetch = async () => fakeRes(500, 'Internal Error');
  await assert.doesNotReject(() => hr.probeReady(1234, '/', Date.now() + 5000, readyRun()));
});
