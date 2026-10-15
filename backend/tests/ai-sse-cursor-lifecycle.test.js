'use strict';

// /api/ai/generate SSE cursor lifecycle. The 3H62 write cursor used to live in
// a module-level Map that was never pruned (one entry per streamed turn), was
// shared with resume requests (a reconnect from Last-Event-ID 5 jumped to the
// owner's write head 10 and lost frames 6-9) and wrote its durable file with a
// synchronous mkdir+write+rename on every content delta.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ad = require('../src/services/agent-runner/engine-adapter');
const w62 = require('../src/services/agent-runner/engine-3h62');

const source = fs.readFileSync(path.join(__dirname, '../src/routes/ai.js'), 'utf8');

// The resume hydrate sequence of /api/ai/generate (cursor → durable → backwards
// guard), run with the real 3H62 helpers against a given cursor store.
function resumeReplayPosition({ position, store, cookieHeader, sessionKey = 'stream-test' }) {
  let replay = position;
  ad.persistSseLastEventIdCursor({ lastEventId: position, store });
  if (!(Number.isFinite(replay) && replay > 0)) {
    const durable = w62.readDurableLastEventIdClosed({ cookieHeader, sessionKey, store });
    if (durable && Number.isFinite(durable.lastEventId) && durable.lastEventId > 0) replay = durable.lastEventId;
  }
  const storedCursor = Number(store && (store.cursor != null ? store.cursor : store.lastEventId));
  const back = ad.rejectLastEventIdGoingBackwards({
    lastEventId: position,
    currentSeq: Number.isFinite(storedCursor) ? storedCursor : position,
    stored: storedCursor,
  });
  if (back && back.ok === false && back.backwards) replay = Number.isFinite(storedCursor) ? storedCursor : replay;
  return replay;
}

test('a shared owner cursor skips the frames a dropped connection lost (the old behaviour)', () => {
  const ownerStore = {};
  ad.persistSseLastEventIdCursor({ lastEventId: 10, seq: 10, store: ownerStore });
  assert.equal(resumeReplayPosition({ position: 5, store: ownerStore }), 10);
});

test('a request-local cursor resumes from the client Last-Event-ID', () => {
  assert.equal(resumeReplayPosition({ position: 5, store: {} }), 5);
  assert.equal(resumeReplayPosition({ position: 0, store: {} }), 0, 'a client with nothing replays everything');
});

test('no module-level per-stream cursor Map survives the turn', () => {
  assert.doesNotMatch(source, /sseLastEventCursorBySession/);
});

test('a resume request builds its cursor store locally', () => {
  const start = source.indexOf('const sid = parsed.streamId;');
  assert.ok(start > 0);
  const hydrate = source.slice(start, source.indexOf('rejectLastEventIdGoingBackwards', start));
  assert.match(hydrate, /const cursorStore = \{\};/);
  assert.doesNotMatch(hydrate, /activeResume|\.set\(sid/);
});

test('the owner cursor lives on activeResume; the delta path never writes the cursor file', () => {
  const at = source.indexOf('const cursorStore = activeResume.cursorStore || (activeResume.cursorStore = {});');
  assert.ok(at > 0, 'the hot path keeps the cursor on the activeResume entry');
  const hotPath = source.slice(at, source.indexOf('_firstTokenAt', at));
  assert.match(hotPath, /persistSseLastEventIdCursor\(/);
  assert.doesNotMatch(hotPath, /persistLastEventIdClosed\(/);
});

test('the terminal flush reads the owner cursor before activeResume is released', () => {
  const terminalRead = source.indexOf('const ownerResume = activeResumeStreams.get(sid);');
  const release = source.indexOf('activeResumeStreams.delete(resumeSession.streamId);');
  assert.ok(terminalRead > 0, 'terminal flush reads the owner cursor');
  assert.ok(release > terminalRead, 'terminal flush runs before the owner entry is deleted');
  const terminal = source.slice(terminalRead, release);
  assert.match(terminal, /Math\.max\(Number\(durableLast\) \|\| 0, Number\(cursorStore\.cursor\) \|\| 0\)/);
  assert.match(terminal, /w62\.persistLastEventIdClosed\(\{/);
});
