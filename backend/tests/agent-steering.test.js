'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSteeringService,
  createMemoryStore,
  formatForPrompt,
  sanitizeNote,
  MAX_NOTES_PER_CHAT,
  MAX_NOTE_CHARS,
  NOTE_TTL_MS,
} = require('../src/services/agent-steering');

function makeClock(start = 1_000_000) {
  let current = start;
  const now = () => current;
  now.advance = (ms) => {
    current += ms;
    return current;
  };
  return now;
}

test('push/drain is FIFO and each note carries {note, userId, ts}', () => {
  const now = makeClock();
  const svc = createSteeringService({ now });

  assert.deepEqual(svc.push({ chatId: 'chat-1', userId: 'u1', note: 'primero' }), {
    ok: true,
    queued: 1,
  });
  now.advance(1000);
  assert.deepEqual(svc.push({ chatId: 'chat-1', userId: 'u2', note: 'segundo' }), {
    ok: true,
    queued: 2,
  });
  now.advance(1000);
  assert.deepEqual(svc.push({ chatId: 'chat-1', userId: 'u1', note: 'tercero' }), {
    ok: true,
    queued: 3,
  });

  const drained = svc.drain({ chatId: 'chat-1' });
  assert.equal(drained.length, 3);
  assert.deepEqual(
    drained.map((n) => n.note),
    ['primero', 'segundo', 'tercero'],
  );
  assert.deepEqual(drained[0], { note: 'primero', userId: 'u1', ts: 1_000_000 });
  assert.deepEqual(drained[1], { note: 'segundo', userId: 'u2', ts: 1_001_000 });

  // drain empties the queue
  assert.deepEqual(svc.drain({ chatId: 'chat-1' }), []);
  assert.equal(svc.peekCount('chat-1'), 0);
});

test('queue caps at 10 notes per chat; the 11th gets queue_full', () => {
  const svc = createSteeringService({ now: makeClock() });

  for (let i = 1; i <= MAX_NOTES_PER_CHAT; i += 1) {
    const res = svc.push({ chatId: 'c', userId: 'u', note: `nota ${i}` });
    assert.deepEqual(res, { ok: true, queued: i });
  }
  assert.deepEqual(svc.push({ chatId: 'c', userId: 'u', note: 'nota 11' }), {
    ok: false,
    error: 'queue_full',
  });
  assert.equal(svc.peekCount('c'), MAX_NOTES_PER_CHAT);

  // draining frees the seats again
  assert.equal(svc.drain({ chatId: 'c' }).length, MAX_NOTES_PER_CHAT);
  assert.deepEqual(svc.push({ chatId: 'c', userId: 'u', note: 'de nuevo' }), {
    ok: true,
    queued: 1,
  });
});

test('notes are sanitized: fenced code blocks stripped, whitespace collapsed, capped at 2000 chars', () => {
  const svc = createSteeringService({ now: makeClock() });

  svc.push({
    chatId: 'san',
    userId: 'u',
    note: 'usa el color azul ```js\nrequire("fs").rmSync("/")\n``` y nada más',
  });
  const [entry] = svc.drain({ chatId: 'san' });
  assert.equal(entry.note, 'usa el color azul y nada más');
  assert.ok(!entry.note.includes('```'));

  // stray unpaired fence is dropped too
  svc.push({ chatId: 'san', userId: 'u', note: 'ojo ``` con esto' });
  assert.equal(svc.drain({ chatId: 'san' })[0].note, 'ojo con esto');

  // newlines collapse so the note renders as one bullet
  svc.push({ chatId: 'san', userId: 'u', note: 'linea 1\nlinea 2\r\nlinea 3' });
  assert.equal(svc.drain({ chatId: 'san' })[0].note, 'linea 1 linea 2 linea 3');

  // oversize input is truncated to the cap
  svc.push({ chatId: 'san', userId: 'u', note: 'x'.repeat(MAX_NOTE_CHARS + 500) });
  assert.equal(svc.drain({ chatId: 'san' })[0].note.length, MAX_NOTE_CHARS);

  // note that sanitizes to nothing is rejected
  assert.deepEqual(svc.push({ chatId: 'san', userId: 'u', note: '```solo codigo```' }), {
    ok: false,
    error: 'empty_note',
  });
  assert.deepEqual(svc.push({ chatId: 'san', userId: 'u', note: '   ' }), {
    ok: false,
    error: 'empty_note',
  });
  assert.deepEqual(svc.push({ chatId: 'san', userId: 'u' }), {
    ok: false,
    error: 'empty_note',
  });
});

test('sanitizeNote is exported and pure', () => {
  assert.equal(sanitizeNote('hola ```x``` mundo'), 'hola mundo');
  assert.equal(sanitizeNote(42), '');
  assert.equal(sanitizeNote(null), '');
});

test('TTL: notes older than 30min are discarded at drain (fake clock)', () => {
  const now = makeClock();
  const svc = createSteeringService({ now });

  svc.push({ chatId: 'ttl', userId: 'u', note: 'vieja' });
  now.advance(NOTE_TTL_MS + 1);
  assert.deepEqual(svc.drain({ chatId: 'ttl' }), []);

  // mixed ages: only the fresh note survives
  svc.push({ chatId: 'ttl', userId: 'u', note: 'caduca' });
  now.advance(NOTE_TTL_MS - 60_000); // 29min later
  svc.push({ chatId: 'ttl', userId: 'u', note: 'fresca' });
  now.advance(120_000); // first note is now 31min old, second 2min old
  const drained = svc.drain({ chatId: 'ttl' });
  assert.deepEqual(
    drained.map((n) => n.note),
    ['fresca'],
  );

  // exactly-at-TTL note is considered stale (strict >)
  svc.push({ chatId: 'ttl', userId: 'u', note: 'al limite' });
  now.advance(NOTE_TTL_MS);
  assert.deepEqual(svc.drain({ chatId: 'ttl' }), []);
});

test('TTL: expired notes do not hold queue seats and peekCount ignores them', () => {
  const now = makeClock();
  const svc = createSteeringService({ now });

  for (let i = 0; i < MAX_NOTES_PER_CHAT; i += 1) {
    svc.push({ chatId: 'seats', userId: 'u', note: `vieja ${i}` });
  }
  now.advance(NOTE_TTL_MS + 1);
  assert.equal(svc.peekCount('seats'), 0);
  // a full-but-expired queue accepts new notes instead of queue_full
  assert.deepEqual(svc.push({ chatId: 'seats', userId: 'u', note: 'nueva' }), {
    ok: true,
    queued: 1,
  });
});

test('pause/unpause per chat', () => {
  const svc = createSteeringService({ now: makeClock() });

  assert.equal(svc.isPaused('p1'), false);
  assert.deepEqual(svc.setPaused({ chatId: 'p1', paused: true, userId: 'u9' }), {
    ok: true,
    paused: true,
  });
  assert.equal(svc.isPaused('p1'), true);
  // pausing does not touch the queue
  svc.push({ chatId: 'p1', userId: 'u9', note: 'sigue en cola' });
  assert.equal(svc.peekCount('p1'), 1);

  assert.deepEqual(svc.setPaused({ chatId: 'p1', paused: false, userId: 'u9' }), {
    ok: true,
    paused: false,
  });
  assert.equal(svc.isPaused('p1'), false);
  assert.equal(svc.peekCount('p1'), 1);

  // draining preserves the pause flag
  svc.setPaused({ chatId: 'p1', paused: true, userId: 'u9' });
  svc.drain({ chatId: 'p1' });
  assert.equal(svc.isPaused('p1'), true);

  assert.deepEqual(svc.setPaused({ paused: true }), { ok: false, error: 'invalid_chat_id' });
});

test('formatForPrompt with 0/1/N notes', () => {
  assert.equal(formatForPrompt([]), '');
  assert.equal(formatForPrompt(undefined), '');
  assert.equal(formatForPrompt(null), '');

  assert.equal(
    formatForPrompt([{ note: 'usa tono formal', userId: 'u', ts: 1 }]),
    '[NOTAS DEL USUARIO A MITAD DE TAREA]\n- usa tono formal',
  );

  const block = formatForPrompt([
    { note: 'primera', userId: 'u', ts: 1 },
    { note: 'segunda', userId: 'u', ts: 2 },
    { note: 'tercera', userId: 'u', ts: 3 },
  ]);
  assert.equal(
    block,
    '[NOTAS DEL USUARIO A MITAD DE TAREA]\n- primera\n- segunda\n- tercera',
  );

  // entries without usable text are skipped; all-empty → ''
  assert.equal(formatForPrompt([{ note: '' }, { userId: 'u' }]), '');

  // the service exposes the same formatter
  const svc = createSteeringService({ now: makeClock() });
  svc.push({ chatId: 'f', userId: 'u', note: 'hola' });
  assert.equal(
    svc.formatForPrompt(svc.drain({ chatId: 'f' })),
    '[NOTAS DEL USUARIO A MITAD DE TAREA]\n- hola',
  );
});

test('chats are isolated: push/drain/pause on one chat never leaks to another', () => {
  const svc = createSteeringService({ now: makeClock() });

  svc.push({ chatId: 'A', userId: 'ua', note: 'nota A1' });
  svc.push({ chatId: 'A', userId: 'ua', note: 'nota A2' });
  svc.push({ chatId: 'B', userId: 'ub', note: 'nota B1' });
  svc.setPaused({ chatId: 'B', paused: true, userId: 'ub' });

  assert.equal(svc.peekCount('A'), 2);
  assert.equal(svc.peekCount('B'), 1);
  assert.equal(svc.isPaused('A'), false);
  assert.equal(svc.isPaused('B'), true);

  const drainedA = svc.drain({ chatId: 'A' });
  assert.deepEqual(
    drainedA.map((n) => n.note),
    ['nota A1', 'nota A2'],
  );
  assert.equal(svc.peekCount('B'), 1);
  assert.deepEqual(
    svc.drain({ chatId: 'B' }).map((n) => n.note),
    ['nota B1'],
  );
});

test('clear drops the queue and pause state for one chat only', () => {
  const svc = createSteeringService({ now: makeClock() });

  svc.push({ chatId: 'x', userId: 'u', note: 'algo' });
  svc.setPaused({ chatId: 'x', paused: true, userId: 'u' });
  svc.push({ chatId: 'y', userId: 'u', note: 'otro' });

  svc.clear('x');
  assert.equal(svc.peekCount('x'), 0);
  assert.equal(svc.isPaused('x'), false);
  assert.deepEqual(svc.drain({ chatId: 'x' }), []);
  assert.equal(svc.peekCount('y'), 1);
});

test('invalid chatId is rejected/neutral everywhere', () => {
  const svc = createSteeringService({ now: makeClock() });

  assert.deepEqual(svc.push({ chatId: '', note: 'hola' }), {
    ok: false,
    error: 'invalid_chat_id',
  });
  assert.deepEqual(svc.push({ note: 'hola' }), { ok: false, error: 'invalid_chat_id' });
  assert.deepEqual(svc.drain({}), []);
  assert.equal(svc.peekCount(undefined), 0);
  assert.equal(svc.isPaused(undefined), false);
  assert.doesNotThrow(() => svc.clear(undefined));

  // numeric chat ids are normalized to strings
  assert.deepEqual(svc.push({ chatId: 123, userId: 'u', note: 'num' }), {
    ok: true,
    queued: 1,
  });
  assert.equal(svc.peekCount('123'), 1);
});

test('store is injectable: a custom Map-like store receives all writes', () => {
  const calls = [];
  const map = new Map();
  const store = {
    get: (k) => map.get(k),
    set: (k, v) => {
      calls.push(['set', k]);
      map.set(k, v);
    },
    delete: (k) => {
      calls.push(['delete', k]);
      map.delete(k);
    },
  };
  const svc = createSteeringService({ store, now: makeClock() });

  svc.push({ chatId: 'inj', userId: 'u', note: 'hola' });
  svc.drain({ chatId: 'inj' });
  svc.clear('inj');

  assert.ok(calls.some(([op, k]) => op === 'set' && k === 'inj'));
  assert.ok(calls.some(([op, k]) => op === 'delete' && k === 'inj'));
});

test('createMemoryStore exposes get/set/delete/clear/size', () => {
  const store = createMemoryStore();
  assert.equal(store.size, 0);
  store.set('a', { x: 1 });
  assert.deepEqual(store.get('a'), { x: 1 });
  assert.equal(store.size, 1);
  store.delete('a');
  assert.equal(store.get('a'), undefined);
  store.set('b', 1);
  store.clear();
  assert.equal(store.size, 0);
});
