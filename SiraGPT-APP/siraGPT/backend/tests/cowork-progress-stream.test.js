'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CoworkProgressStream,
  createProgressStream,
  writeSSE,
  STAGES,
  STAGE_LABELS,
} = require('../src/services/cowork-progress-stream');

test('exports the documented surface', () => {
  assert.equal(typeof CoworkProgressStream, 'function');
  assert.equal(typeof createProgressStream, 'function');
  assert.equal(typeof writeSSE, 'function');
  assert.equal(typeof STAGES, 'object');
  assert.equal(typeof STAGE_LABELS, 'object');
});

test('STAGES + STAGE_LABELS cover every documented stage', () => {
  for (const s of Object.values(STAGES)) {
    assert.ok(STAGE_LABELS[s], `expected label for stage ${s}`);
  }
});

test('createProgressStream returns a fresh CoworkProgressStream instance with a synthetic analysisId', () => {
  const a = createProgressStream();
  const b = createProgressStream();
  assert.ok(a instanceof CoworkProgressStream);
  assert.ok(b instanceof CoworkProgressStream);
  assert.notEqual(a.analysisId, b.analysisId);
  assert.match(a.analysisId, /^analysis_/);
});

test('opts.analysisId is honoured when provided', () => {
  const s = createProgressStream({ analysisId: 'fixed-id-1' });
  assert.equal(s.analysisId, 'fixed-id-1');
});

test('start() emits "start" with analysisId + timestamp', () => {
  const s = createProgressStream({ analysisId: 'a' });
  let received = null;
  s.on('start', (e) => { received = e; });
  s.start();
  assert.ok(received);
  assert.equal(received.analysisId, 'a');
  assert.equal(typeof received.timestamp, 'number');
  s.destroy();
});

test('advance() emits "stage" event with elapsedMs, previousStage and history grows', () => {
  const s = createProgressStream({ analysisId: 'a' });
  s.start();
  const events = [];
  s.on('stage', (e) => events.push(e));
  s.advance(STAGES.DETECTING_FORMAT);
  s.advance(STAGES.INGESTING, { fileName: 'x.pdf' });
  assert.equal(events.length, 2);
  assert.equal(events[0].stage, STAGES.DETECTING_FORMAT);
  assert.equal(events[0].stageLabel, STAGE_LABELS[STAGES.DETECTING_FORMAT]);
  assert.equal(events[1].previousStage, STAGES.DETECTING_FORMAT);
  assert.equal(events[1].fileName, 'x.pdf');
  assert.ok(events[1].elapsedMs >= 0);
  assert.equal(s.stageHistory.length, 2);
  s.destroy();
});

test('complete() emits "complete", stamps results, and stops heartbeats', () => {
  const s = createProgressStream({ analysisId: 'a' });
  s.start();
  let received = null;
  s.on('complete', (e) => { received = e; });
  s.complete({ summary: 'done' });
  assert.ok(received);
  assert.equal(received.stage, STAGES.COMPLETE);
  assert.deepEqual(received.results, { summary: 'done' });
  assert.equal(s.currentStage, STAGES.COMPLETE);
  assert.equal(typeof s.completedAt, 'number');
  // Heartbeat must be stopped after complete
  assert.equal(s._heartbeat, null);
  s.destroy();
});

test('fail() with an Error captures the message and emits "error"', () => {
  const s = createProgressStream();
  s.start();
  let received = null;
  s.on('error', (e) => { received = e; });
  s.fail(new Error('boom'));
  assert.equal(received.stage, STAGES.ERROR);
  assert.equal(received.error, 'boom');
  assert.equal(s.error, 'boom');
  s.destroy();
});

test('fail() with a string captures the string verbatim', () => {
  const s = createProgressStream();
  s.start();
  let received = null;
  s.on('error', (e) => { received = e; });
  s.fail('plain reason');
  assert.equal(received.error, 'plain reason');
  s.destroy();
});

test('fail() falls back to "Unknown error" when the input has no message', () => {
  const s = createProgressStream();
  s.start();
  let received = null;
  s.on('error', (e) => { received = e; });
  s.fail({});
  assert.equal(received.error, 'Unknown error');
  s.destroy();
});

test('getStatus() returns the live shape (analysisId, stage, stageLabel, counters)', () => {
  const s = createProgressStream({ analysisId: 'a' });
  s.start();
  s.advance(STAGES.INGESTING);
  const status = s.getStatus();
  assert.equal(status.analysisId, 'a');
  assert.equal(status.stage, STAGES.INGESTING);
  assert.equal(status.stageLabel, STAGE_LABELS[STAGES.INGESTING]);
  assert.equal(typeof status.startedAt, 'number');
  assert.equal(status.completedAt, null);
  assert.ok(status.stageCount >= 1);
  s.destroy();
});

test('toSSEFormat() returns { event, data } where data is JSON-serialised status', () => {
  const s = createProgressStream({ analysisId: 'a' });
  s.start();
  const out = s.toSSEFormat();
  assert.equal(out.event, 'cowork_progress');
  const parsed = JSON.parse(out.data);
  assert.equal(parsed.analysisId, 'a');
  assert.equal(parsed.stage, STAGES.IDLE);
  s.destroy();
});

test('destroy() removes all listeners and stops heartbeats', () => {
  const s = createProgressStream();
  s.start();
  s.on('stage', () => {});
  s.on('complete', () => {});
  assert.ok(s.listenerCount('stage') > 0);
  s.destroy();
  assert.equal(s.listenerCount('stage'), 0);
  assert.equal(s.listenerCount('complete'), 0);
  assert.equal(s._heartbeat, null);
});

test('writeSSE wires SSE headers and forwards stage/complete events to res.write', () => {
  const s = createProgressStream({ analysisId: 'a' });
  const written = [];
  const headers = {};
  let headersSent = false;
  let ended = false;
  const closeListeners = [];
  const res = {
    get writableEnded() { return ended; },
    get headersSent() { return headersSent; },
    setHeader(k, v) { headers[k] = v; },
    flushHeaders() { headersSent = true; },
    write(chunk) { written.push(chunk); },
    end() { ended = true; },
    on(event, fn) { if (event === 'close') closeListeners.push(fn); },
  };
  writeSSE(res, s);
  assert.equal(headers['Content-Type'], 'text/event-stream');
  assert.equal(headers['Cache-Control'], 'no-cache');
  assert.equal(headers['Connection'], 'keep-alive');
  assert.equal(headersSent, true);

  s.start();
  s.advance(STAGES.INGESTING);
  s.complete({ ok: true });

  const stageChunk = written.find((c) => c.startsWith('event: cowork_stage\n'));
  const completeChunk = written.find((c) => c.startsWith('event: cowork_complete\n'));
  assert.ok(stageChunk, 'must emit cowork_stage');
  assert.ok(completeChunk, 'must emit cowork_complete');
  assert.equal(ended, true, 'complete must end the response');

  // Manually trigger the close listener to ensure cleanup runs without error
  for (const fn of closeListeners) fn();
  // After cleanup, the stream listeners should be removed; emitting another
  // event must not write further.
  written.length = 0;
  s.advance(STAGES.FINALIZING);
  assert.equal(written.length, 0, 'no writes after res close');
});
