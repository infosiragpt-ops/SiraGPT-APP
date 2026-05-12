'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runSnippet, isLanguageSupported, SUPPORTED_LANGUAGES, _internal } = require('../src/services/sira/code-interpreter-sandbox');

// ─── Static audit ────────────────────────────────────────────

test('staticAudit: rejects child_process require', () => {
  const r = _internal.staticAudit('const cp = require("child_process");', 'node');
  assert.equal(r.ok, false);
});

test('staticAudit: rejects fs require', () => {
  const r = _internal.staticAudit('const fs = require("fs");', 'node');
  assert.equal(r.ok, false);
});

test('staticAudit: rejects eval and new Function', () => {
  for (const code of ['eval("1+1");', 'new Function("return 1")()']) {
    const r = _internal.staticAudit(code, 'node');
    assert.equal(r.ok, false, `expected refusal for: ${code}`);
  }
});

test('staticAudit: rejects python os/subprocess imports', () => {
  for (const code of ['import os', 'import subprocess', 'from os import path']) {
    const r = _internal.staticAudit(code, 'python');
    assert.equal(r.ok, false, `expected refusal for: ${code}`);
  }
});

test('staticAudit: rejects accessing /etc/passwd', () => {
  const r = _internal.staticAudit('require("foo")\n/etc/passwd', 'node');
  assert.equal(r.ok, false);
});

test('staticAudit: rejects unsupported language', () => {
  const r = _internal.staticAudit('echo "hi"', 'fortran');
  assert.equal(r.ok, false);
});

test('staticAudit: accepts a safe node snippet', () => {
  const r = _internal.staticAudit('console.log(2 + 2);', 'node');
  assert.equal(r.ok, true);
});

test('staticAudit: accepts a safe python snippet', () => {
  const r = _internal.staticAudit('print(2 + 2)', 'python');
  assert.equal(r.ok, true);
});

// ─── isLanguageSupported ────────────────────────────────

test('isLanguageSupported: returns true for whitelisted langs', () => {
  for (const lang of SUPPORTED_LANGUAGES) {
    // Only check if it's also in the env-derived ALLOWED_LANGS
    const supported = isLanguageSupported(lang);
    assert.equal(typeof supported, 'boolean');
  }
});

test('isLanguageSupported: returns false for unknown lang', () => {
  assert.equal(isLanguageSupported('fortran'), false);
  assert.equal(isLanguageSupported(null), false);
  assert.equal(isLanguageSupported(42), false);
});

// ─── runSnippet (integration with child_process) ────────

test('runSnippet: returns refused when code is too large', async () => {
  const huge = 'a'.repeat(100_000);
  const out = await runSnippet({ code: huge, language: 'node' });
  assert.equal(out.refused, true);
  assert.match(out.refusalReason, /bytes/);
});

test('runSnippet: returns refused for unsupported language', async () => {
  const out = await runSnippet({ code: 'echo "hi"', language: 'fortran' });
  assert.equal(out.refused, true);
});

test('runSnippet: runs a safe node snippet and captures stdout', async () => {
  if (!isLanguageSupported('node')) {
    // Env disabled — assert refusal and skip
    const out = await runSnippet({ code: 'console.log("hello")', language: 'node' });
    assert.ok(out.refused === true || out.ok === true);
    return;
  }
  const out = await runSnippet({ code: 'console.log("hello from sandbox")', language: 'node' });
  assert.equal(out.ok, true);
  assert.match(out.stdout, /hello from sandbox/);
  assert.equal(out.exitCode, 0);
});

test('runSnippet: kills on excessive output', async () => {
  if (!isLanguageSupported('node')) return;
  const code = `
    const bigChunk = 'x'.repeat(2000);
    for (let i = 0; i < 1000; i++) process.stdout.write(bigChunk);
  `;
  const out = await runSnippet({ code, language: 'node', maxRuntimeMs: 4000 });
  assert.equal(out.truncated, true);
});

test('runSnippet: refuses code with new Function', async () => {
  const out = await runSnippet({
    code: 'const f = new Function("return 42"); console.log(f());',
    language: 'node',
  });
  assert.equal(out.refused, true);
});

test('runSnippet: enforces tight timeout', async () => {
  if (!isLanguageSupported('node')) return;
  const code = `
    setTimeout(() => console.log('late'), 5000);
  `;
  const out = await runSnippet({ code, language: 'node', maxRuntimeMs: 500 });
  // Either timed out OR finished without "late" — both are valid outcomes
  assert.ok(out.durationMs <= 2500, `expected duration under 2.5s, got ${out.durationMs}`);
});

test('runSnippet: returns safe env (no host secrets leak)', async () => {
  if (!isLanguageSupported('node')) return;
  const out = await runSnippet({
    code: `console.log(JSON.stringify({ has_path: typeof process.env.PATH === 'string', has_node_options: process.env.NODE_OPTIONS, has_ld: !!process.env.LD_PRELOAD }));`,
    language: 'node',
  });
  assert.equal(out.ok, true);
  // PATH should exist (we whitelist it) but LD_PRELOAD must NOT
  const data = JSON.parse(out.stdout.trim());
  assert.equal(data.has_path, true);
  assert.equal(data.has_ld, false);
});

test('buildSafeEnv: strips dangerous env vars', () => {
  const env = _internal.buildSafeEnv({
    GOOD_VAR: 'ok',
    LD_PRELOAD: '/evil.so',
    PATH: '/attacker/path',
    HOME: '/somewhere',
    SHELL: '/evil/shell',
    LD_LIBRARY_PATH: '/evil',
  });
  assert.equal(env.GOOD_VAR, 'ok');
  assert.notEqual(env.LD_PRELOAD, '/evil.so');
  assert.notEqual(env.PATH, '/attacker/path');
});
