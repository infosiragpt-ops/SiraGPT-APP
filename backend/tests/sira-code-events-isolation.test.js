'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');

// Exercise the real engine stream, session store and event bus without starting
// a server, creating workspaces, or loading a model. Sessions are synthetic.
function fixture() {
  const sources = path.join(__dirname, '../src/services/sira-code');
  function load(name, dependencies) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(sources, `${name}.js`), 'utf8'), {
      module,
      exports: module.exports,
      require: (id) => dependencies[id] || {},
    }, { filename: `${name}.js` });
    return module.exports;
  }
  const events = load('events', {
    events: { EventEmitter },
    '../agent-runner/trace': { STAGE_LABELS: {} },
  });
  const store = load('session-store', { crypto: require('node:crypto') });
  const sessions = store.sessions;
  const engine = load('engine', {
    './events': events,
    './session-store': store,
  });
  function session(id, userId) {
    const row = { id, userId, seq: 0, events: [] };
    sessions.set(id, row);
    return row;
  }
  function stream(options) {
    const frames = [];
    const close = engine.streamEvents({ write: (frame) => frames.push(frame) }, options);
    return { frames, close };
  }
  return { engine, events, sessions, session, stream };
}

test('a stream without sessionId emits only sessions owned by its user', () => {
  const f = fixture();
  const a = f.session('session-a', 'user-a');
  const a2 = f.session('session-a2', 'user-a');
  const b = f.session('session-b', 'user-b');
  const unowned = f.session('session-unowned', '');
  const stream = f.stream({ userId: 'user-a' });
  try {
    f.events.appendEvent(b, 'message', { content: 'private synthetic B' });
    f.events.appendEvent(a, 'message', { content: 'synthetic A' });
    f.events.appendEvent(a2, 'message', { content: 'synthetic A2' });
    f.events.appendEvent(unowned, 'message', { content: 'unowned synthetic' });
    assert.equal(stream.frames.length, 2);
    assert.ok(stream.frames.every((frame) => !frame.includes('private synthetic B')));
    assert.ok(stream.frames[0].includes('synthetic A'));
    assert.ok(stream.frames[1].includes('synthetic A2'));
  } finally {
    stream.close();
  }
});

test('a session stream replays and follows only its owned session', () => {
  const f = fixture();
  const a = f.session('session-a', 'user-a');
  const a2 = f.session('session-a2', 'user-a');
  const b = f.session('session-b', 'user-b');
  f.events.appendEvent(a, 'message', { content: 'old A' });
  const cursor = f.events.appendEvent(a, 'message', { content: 'cursor A' });
  f.events.appendEvent(a, 'message', { content: 'replayed A' });
  const stream = f.stream({ userId: 'user-a', sessionId: a.id, lastEventId: cursor.id });
  try {
    f.events.appendEvent(b, 'message', { content: 'private synthetic B' });
    f.events.appendEvent(a2, 'message', { content: 'other owned session' });
    f.events.appendEvent(a, 'message', { content: 'live A' });
    assert.equal(stream.frames.length, 2);
    assert.ok(stream.frames[0].includes('replayed A'));
    assert.ok(stream.frames[1].includes('live A'));
  } finally {
    stream.close();
  }
});

test('missing user identity is rejected before adding any event listener', () => {
  const f = fixture();
  for (const userId of [undefined, null, '', '   ']) {
    assert.throws(() => f.stream({ userId }), (error) => error.status === 401);
  }
  assert.equal(f.events.bus.listenerCount('event'), 0);
});

test('a foreign explicit session is rejected before adding a listener', () => {
  const f = fixture();
  const b = f.session('session-b', 'user-b');
  assert.throws(
    () => f.stream({ userId: 'user-a', sessionId: b.id }),
    (error) => error.status === 404,
  );
  assert.equal(f.events.bus.listenerCount('event'), 0);
  assert.equal(f.events.bus.listenerCount(`session:${b.id}`), 0);
});

test('an explicit session without an owner is not authorized for a user', () => {
  const f = fixture();
  const unowned = f.session('session-unowned', '');
  assert.throws(
    () => f.stream({ userId: 'user-a', sessionId: unowned.id }),
    (error) => error.status === 404,
  );
  assert.equal(f.events.bus.listenerCount(`session:${unowned.id}`), 0);
});

test('a global stream drops unknown or no-longer-owned sessions', () => {
  const f = fixture();
  const a = f.session('session-a', 'user-a');
  const stream = f.stream({ userId: 'user-a' });
  try {
    f.sessions.delete(a.id);
    f.events.appendEvent(a, 'message', { content: 'deleted synthetic session' });
    const b = f.session('session-b', 'user-a');
    b.userId = 'user-b';
    f.events.appendEvent(b, 'message', { content: 'changed synthetic owner' });
    assert.equal(stream.frames.length, 0);
  } finally {
    stream.close();
  }
});

test('unsubscribe stops delivery and removes global or session listeners', () => {
  for (const scoped of [false, true]) {
    const f = fixture();
    const a = f.session('session-a', 'user-a');
    const stream = f.stream({ userId: 'user-a', ...(scoped ? { sessionId: a.id } : {}) });
    const key = scoped ? `session:${a.id}` : 'event';
    assert.equal(f.events.bus.listenerCount(key), 1);
    stream.close();
    assert.equal(f.events.bus.listenerCount(key), 0);
    f.events.appendEvent(a, 'message', { content: 'after unsubscribe' });
    assert.equal(stream.frames.length, 0);
  }
});
