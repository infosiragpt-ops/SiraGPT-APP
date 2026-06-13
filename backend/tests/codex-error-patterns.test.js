'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');

const { classifyText, toActionRequired, benignAnnotation, PATTERNS, BY_ID } = require('../src/services/codex/error-patterns');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'codex-logs', name), 'utf8');

test('real OpenRouter 402 log fixture classifies as the blocking credits pattern', () => {
  const c = classifyText(fixture('openrouter-402.log'));
  assert.equal(c.severity, 'blocking');
  assert.equal(c.pattern.id, 'openrouter_402');
});

test('real Vite boot log fixture: ECONNREFUSED is benign within the boot window', () => {
  const log = fixture('vite-boot.log');
  const c = classifyText(log, { bootElapsedMs: 1500 });
  assert.equal(c.severity, 'benign');
  // The same log outside the boot window falls through to the next benign match
  // (npm WARN), never to a blocking one.
  const late = classifyText(log, { bootElapsedMs: 90_000 });
  assert.equal(late.severity, 'benign');
  assert.notEqual(late.pattern.id, 'econnrefused_boot');
});

test('openrouter_402 matches a real 402 credits error and exposes remediation', () => {
  const log = 'OpenRouter error 402: Insufficient credits. Add more at https://openrouter.ai/credits';
  const c = classifyText(log);
  assert.equal(c.severity, 'blocking');
  assert.equal(c.pattern.id, 'openrouter_402');
  const ev = toActionRequired(c.pattern, log);
  assert.equal(ev.patternId, 'openrouter_402');
  assert.deepEqual(ev.blockedCapabilities, ['Generación con modelos de OpenRouter']);
  assert.equal(ev.remediationUrl, 'https://openrouter.ai/credits');
  assert.equal(ev.rawError, log);
});

test('openrouter_402 does NOT match an unrelated 402 or a credits mention alone', () => {
  assert.equal(classifyText('HTTP 402 Payment Required (generic)')?.pattern.id !== 'openrouter_402', true);
  assert.equal(classifyText('you have plenty of credits'), null);
});

test('quota_exhausted matches the internal credit 402 (not OpenRouter)', () => {
  const c = classifyText('Error 402: límite de créditos del plan alcanzado');
  assert.equal(c.pattern.id, 'quota_exhausted');
  assert.equal(c.pattern.remediationUrl, '/api/free-ia/plans');
});

test('missing_api_key matches 401/unauthorized/api key errors', () => {
  assert.equal(classifyText('401 Unauthorized: invalid api key').pattern.id, 'missing_api_key');
  assert.equal(classifyText('Error: missing API key for provider').pattern.id, 'missing_api_key');
});

test('provision_failed matches runner-unreachable signals', () => {
  assert.equal(classifyText('RunnerError: runner unreachable: fetch failed').pattern.id, 'provision_failed');
  assert.equal(classifyText('connect ECONNREFUSED 127.0.0.1:4097').pattern.id, 'provision_failed');
});

test('econnrefused_boot is benign ONLY inside the boot window', () => {
  const log = 'Proxy error: connect ECONNREFUSED 127.0.0.1:5173';
  const inWindow = classifyText(log, { bootElapsedMs: 2000 });
  assert.equal(inWindow.severity, 'benign');
  assert.equal(inWindow.pattern.id, 'econnrefused_boot');
  // Outside the window → not auto-benign (could be a genuinely dead dev server).
  const outside = classifyText(log, { bootElapsedMs: 60_000 });
  assert.equal(outside, null);
  // No context at all → not auto-benign either.
  assert.equal(classifyText(log), null);
});

test('peer_deps_warn and vite_port_retry are benign', () => {
  assert.equal(classifyText('npm WARN deprecated foo@1.0.0').pattern.id, 'peer_deps_warn');
  assert.equal(classifyText('Port 5173 is in use, trying another one instead').pattern.id, 'vite_port_retry');
});

test('a blocking pattern wins over a benign one when both match', () => {
  // Text carries both a benign npm WARN AND a blocking 402 credits error.
  const mixed = 'npm WARN peer dep mismatch\nOpenRouter 402 Insufficient credits';
  const c = classifyText(mixed, { bootElapsedMs: 1000 });
  assert.equal(c.severity, 'blocking');
  assert.equal(c.pattern.id, 'openrouter_402');
});

test('classifyText returns null for clean text and empty input', () => {
  assert.equal(classifyText('Compiled successfully. Ready in 320ms.'), null);
  assert.equal(classifyText(''), null);
  assert.equal(classifyText(null), null);
});

test('benignAnnotation prefixes the explanation for the timeline', () => {
  assert.match(benignAnnotation(BY_ID.peer_deps_warn), /^\[diagnóstico\] /);
});

test('every pattern has the required declarative fields', () => {
  for (const p of PATTERNS) {
    assert.ok(p.id && p.severity && typeof p.match === 'function' && p.title);
    assert.ok(Array.isArray(p.blockedCapabilities));
    assert.ok(['blocking', 'benign'].includes(p.severity));
  }
});

test('rawError is capped at 10k chars in action_required', () => {
  const huge = 'x'.repeat(20_000);
  const ev = toActionRequired(BY_ID.openrouter_402, huge);
  assert.equal(ev.rawError.length, 10_000);
});
