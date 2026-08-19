/**
 * Unit tests for services/gist-memory.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const gist = require('../src/services/gist-memory');

test('append + get: basic accumulation in order', () => {
  const sid = `s-${Math.random()}`;
  gist.append(sid, [
    { subject: 'A', predicate: 'is', object: 'B' },
    { subject: 'C', predicate: 'is', object: 'D' },
  ]);
  gist.append(sid, [
    { subject: 'E', predicate: 'is', object: 'F' },
  ]);
  const got = gist.get(sid);
  assert.equal(got.length, 3);
  assert.deepEqual(got.map(t => t.subject), ['A', 'C', 'E']);
});

test('append: dedupes by (s|p|o) case-insensitive', () => {
  const sid = `s-${Math.random()}`;
  gist.append(sid, [{ subject: 'Curry', predicate: 'plays for', object: 'Warriors' }]);
  const r = gist.append(sid, [
    { subject: 'curry', predicate: 'PLAYS FOR', object: 'warriors' }, // same
    { subject: 'Curry', predicate: 'born in', object: 'Akron' },
  ]);
  assert.equal(r.appended, 1);
  assert.equal(gist.get(sid).length, 2);
});

test('append: skips malformed triples', () => {
  const sid = `s-${Math.random()}`;
  const r = gist.append(sid, [
    { subject: 'A', predicate: 'is', object: 'B' },
    { subject: 'only-subject' },
    null,
    {},
  ]);
  assert.equal(r.appended, 1);
});

test('get: distinct sessions are isolated', () => {
  const s1 = `a-${Math.random()}`;
  const s2 = `b-${Math.random()}`;
  gist.append(s1, [{ subject: 'A', predicate: 'is', object: 'B' }]);
  gist.append(s2, [{ subject: 'X', predicate: 'is', object: 'Y' }]);
  assert.equal(gist.get(s1).length, 1);
  assert.equal(gist.get(s2).length, 1);
  assert.notEqual(gist.get(s1)[0].subject, gist.get(s2)[0].subject);
});

test('get: unknown session returns []', () => {
  assert.deepEqual(gist.get('never-used'), []);
});

test('clear: drops the session', () => {
  const sid = `s-${Math.random()}`;
  gist.append(sid, [{ subject: 'A', predicate: 'is', object: 'B' }]);
  assert.equal(gist.get(sid).length, 1);
  gist.clear(sid);
  assert.equal(gist.get(sid).length, 0);
});

test('stats: reports triples count and timestamps', () => {
  const sid = `s-${Math.random()}`;
  gist.append(sid, [{ subject: 'A', predicate: 'is', object: 'B' }]);
  const st = gist.stats(sid);
  assert.equal(st.triples, 1);
  assert.ok(st.lastTouched > 0);
  assert.ok(st.ageMs >= 0);
});

test('MAX_TRIPLES_PER_SESSION: oldest-wins eviction', () => {
  const sid = `s-${Math.random()}`;
  const cap = gist.MAX_TRIPLES_PER_SESSION;
  const batch = Array.from({ length: cap + 5 }, (_, i) => ({
    subject: `S${i}`, predicate: 'is', object: `O${i}`,
  }));
  gist.append(sid, batch);
  const got = gist.get(sid);
  assert.equal(got.length, cap);
  // Oldest 5 should be gone — the first remaining is S5.
  assert.equal(got[0].subject, 'S5');
});
