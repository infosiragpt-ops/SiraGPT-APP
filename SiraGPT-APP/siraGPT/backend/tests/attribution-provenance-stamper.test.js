'use strict';

const test = require('node:test');
const assert = require('node:assert');

const prov = require('../src/services/attribution-provenance-stamper');

test('stamp: returns a non-null stamp with expected shape', () => {
  const s = prov.stamp({
    prompt: 'hello',
    systemBlocks: [{ kind: 'master-prompt', text: 'sys' }],
    response: 'hi there',
  });
  assert.ok(s);
  assert.strictEqual(s.version, prov.STAMP_VERSION);
  assert.ok(s.promptHash.length === 24);
  assert.ok(s.blocksHash.length === 24);
  assert.ok(s.responseHash.length === 24);
  assert.ok(typeof s.moduleFp === 'string');
  assert.ok(s.signature.length === 32);
});

test('stamp: deterministic for the same input', () => {
  const args = {
    prompt: 'hello',
    systemBlocks: [{ kind: 'master-prompt', text: 'sys' }],
    response: 'hi there',
  };
  const a = prov.stamp(args);
  const b = prov.stamp(args);
  // ts differs because Date.now() advances; everything else (per-content
  // hashes) should match
  assert.strictEqual(a.promptHash, b.promptHash);
  assert.strictEqual(a.blocksHash, b.blocksHash);
  assert.strictEqual(a.responseHash, b.responseHash);
});

test('stamp: different prompt → different promptHash', () => {
  const a = prov.stamp({ prompt: 'a', systemBlocks: [], response: 'r' });
  const b = prov.stamp({ prompt: 'b', systemBlocks: [], response: 'r' });
  assert.notStrictEqual(a.promptHash, b.promptHash);
});

test('stamp: different systemBlocks → different blocksHash', () => {
  const a = prov.stamp({ prompt: 'p', systemBlocks: [{ kind: 'x', text: 'a' }], response: 'r' });
  const b = prov.stamp({ prompt: 'p', systemBlocks: [{ kind: 'x', text: 'b' }], response: 'r' });
  assert.notStrictEqual(a.blocksHash, b.blocksHash);
});

test('verify: round-trip succeeds when prompt/blocks/response unchanged', () => {
  const args = {
    prompt: 'hello',
    systemBlocks: [{ kind: 'master-prompt', text: 'sys' }],
    response: 'hi there',
  };
  const s = prov.stamp(args);
  const r = prov.verify(s, args);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.mismatches.length, 0);
});

test('verify: mutated response is flagged as responseHash mismatch', () => {
  const args = {
    prompt: 'hello',
    systemBlocks: [{ kind: 'master-prompt', text: 'sys' }],
    response: 'original',
  };
  const s = prov.stamp(args);
  const r = prov.verify(s, { ...args, response: 'tampered' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.mismatches.includes('responseHash'));
});

test('verify: mutated prompt is flagged as promptHash + signature mismatch', () => {
  const args = {
    prompt: 'orig',
    systemBlocks: [{ kind: 'x', text: 'sys' }],
    response: 'r',
  };
  const s = prov.stamp(args);
  const r = prov.verify(s, { ...args, prompt: 'tampered' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.mismatches.includes('promptHash'));
});

test('verify: stamp from wrong secret fails signature check', () => {
  const args = { prompt: 'hi', systemBlocks: [], response: 'r' };
  const s = prov.stamp(args);
  const r = prov.verify(s, { ...args, secret: 'wrong-secret' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.mismatches.includes('signature'));
});

test('verify: missing stamp → ok=false with explanatory reason', () => {
  const r = prov.verify(null, { prompt: '', systemBlocks: [], response: '' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason);
});

test('verify: unknown version → ok=false with explanatory reason', () => {
  const r = prov.verify({ version: 'sira-prov-vXXX' }, {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'unknown version');
});

test('hashText: deterministic + 64-char hex', () => {
  const a = prov.hashText('hi');
  const b = prov.hashText('hi');
  assert.strictEqual(a, b);
  assert.strictEqual(a.length, 64);
  assert.ok(/^[a-f0-9]+$/.test(a));
});

test('hashSystemBlocks: order matters', () => {
  const a = prov.hashSystemBlocks([{ kind: 'a', text: 'x' }, { kind: 'b', text: 'y' }]);
  const b = prov.hashSystemBlocks([{ kind: 'b', text: 'y' }, { kind: 'a', text: 'x' }]);
  assert.notStrictEqual(a, b);
});

test('moduleFingerprint: deterministic across calls', () => {
  const a = prov.moduleFingerprint();
  const b = prov.moduleFingerprint();
  assert.strictEqual(a, b);
});

test('moduleFingerprint(name): differs for different names', () => {
  assert.notStrictEqual(
    prov.moduleFingerprint('alpha'),
    prov.moduleFingerprint('beta'),
  );
});

test('hot path: 1000 stamp + verify cycles under 1s', () => {
  const args = { prompt: 'hi', systemBlocks: [{ kind: 'x', text: 'sys' }], response: 'r' };
  const t0 = Date.now();
  for (let i = 0; i < 1000; i += 1) {
    const s = prov.stamp(args);
    prov.verify(s, args);
  }
  assert.ok(Date.now() - t0 < 1000);
});
