'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  frameShowsProviderFirstByte,
  sseFrameShowsProviderFirstByte,
  installFirstByteProbe,
} = require('../src/services/generate-first-byte');
const ad = require('../src/services/agent-runner/engine-adapter');

const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

test('reasoning and tool-call deltas count as the provider first byte', () => {
  assert.equal(frameShowsProviderFirstByte({ type: 'reasoning_delta', reasoning: 'Voy a ' }), true);
  assert.equal(frameShowsProviderFirstByte({ type: 'tool_call_delta', index: 0, name: 'x' }), true);
  assert.equal(frameShowsProviderFirstByte({ type: 'text_delta', content: 'Hola' }), true);
  assert.equal(frameShowsProviderFirstByte({ content: 'Hola' }), true);
});

test('server-side frames never count as a first byte', () => {
  assert.equal(frameShowsProviderFirstByte({ type: 'start', at: 1 }), false);
  assert.equal(frameShowsProviderFirstByte({ type: 'stage', label: 'Leyendo' }), false);
  assert.equal(frameShowsProviderFirstByte({ type: 'stage', label: 'Buscando en la web', tool: 'web_search' }), false);
  assert.equal(frameShowsProviderFirstByte({ type: 'reasoning_delta', reasoning: '' }), false);
  assert.equal(frameShowsProviderFirstByte({ type: 'reasoning_done', durationMs: 5 }), false);
  assert.equal(frameShowsProviderFirstByte({ content: '' }), false);
  assert.equal(frameShowsProviderFirstByte({ content: 'x', _resumed: true }), false);
  assert.equal(frameShowsProviderFirstByte({ error: 'boom', content: 'x' }), false);
  assert.equal(frameShowsProviderFirstByte(null), false);
  assert.equal(sseFrameShowsProviderFirstByte(': ping 1\n\n'), false);
  assert.equal(sseFrameShowsProviderFirstByte('data: [DONE]\n\n'), false);
  assert.equal(sseFrameShowsProviderFirstByte('data: {not json'), false);
  assert.equal(sseFrameShowsProviderFirstByte(frame({ type: 'reasoning_delta', reasoning: 'a' })), true);
});

test('probe stamps once on the first provider frame and keeps writing through', () => {
  const written = [];
  const res = { write: (p) => { written.push(p); return true; } };
  const stamps = [];
  installFirstByteProbe(res, (at) => stamps.push(at));
  res.write(frame({ type: 'start', at: 1 }));
  res.write(': heartbeat\n\n');
  assert.equal(stamps.length, 0);
  res.write(frame({ type: 'reasoning_delta', reasoning: 'pensando' }));
  res.write(frame({ type: 'reasoning_delta', reasoning: ' más' }));
  res.write(frame({ type: 'text_delta', content: 'Hola' }));
  assert.equal(stamps.length, 1);
  assert.equal(written.length, 5);
});

test('a Grok-style 60 s thinking phase no longer trips the 45 s TTFB abort', () => {
  const startedAt = 1_000;
  let firstByteAt = null;
  const res = { write: () => true };
  installFirstByteProbe(res, (at) => { if (firstByteAt == null) firstByteAt = at; });
  // Before any provider frame the watchdog would abort at 45 s.
  assert.equal(ad.abortIfFirstByteOver45s({ startedAt, now: startedAt + 45_000, firstByteAt }).abort, true);
  res.write(frame({ type: 'reasoning_delta', reasoning: 'Analizando el repo…' }));
  assert.ok(firstByteAt != null);
  assert.equal(ad.abortIfFirstByteOver45s({ startedAt, now: startedAt + 60_000, firstByteAt }).abort, false);
});

test('generate route wires the probe before the TTFB watchdog interval', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');
  const probeAt = src.indexOf("require('../services/generate-first-byte')");
  const watchdogAt = src.indexOf('__firstByteWatchdog = setInterval(');
  assert.ok(probeAt > 0, 'probe required in ai.js');
  assert.ok(watchdogAt > probeAt, 'probe installed before the watchdog interval');
  assert.match(src.slice(probeAt, watchdogAt), /installFirstByteProbe\(res/);
});

test('document editor stages count as the first byte so a 2-minute Word fill is not aborted at 45 s', () => {
  assert.equal(frameShowsProviderFirstByte({ type: 'stage', label: 'Editando documento original', tool: 'document_edit' }), true);
  assert.equal(frameShowsProviderFirstByte({ type: 'stage', label: 'Agente trabajando', tool: 'agent_runner' }), true);
  const startedAt = 1_000;
  let firstByteAt = null;
  const res = { write: () => true };
  installFirstByteProbe(res, (at) => { if (firstByteAt == null) firstByteAt = at; });
  res.write(frame({ type: 'stage', label: 'Leyendo la estructura del documento', tool: 'document_edit' }));
  assert.ok(firstByteAt != null);
  assert.equal(ad.abortIfFirstByteOver45s({ startedAt, now: startedAt + 120_000, firstByteAt }).abort, false);
});

test('generate route never "recovers" an edit turn with the extracted document text', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');
  assert.match(src, /let __attachmentRecoveryAllowed = true;/);
  assert.match(src, /isDocumentEditRequest\(prompt\)\) __attachmentRecoveryAllowed = false;/);
  assert.match(src, /if \(__ttfbAbortedAt != null \|\| [^\n]*controller\.signal\.aborted\)\) __attachmentRecoveryAllowed = false;/);
  assert.match(src, /processedFiles\.length > 0 && __attachmentRecoveryAllowed\) \{/);
  assert.match(src, /&& __attachmentRecoveryAllowed\n\s+&& chatAttachmentRecovery\.shouldRecoverAttachmentResponse\(/);
});
