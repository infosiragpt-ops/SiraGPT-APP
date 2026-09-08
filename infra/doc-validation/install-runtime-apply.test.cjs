'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArchive, quote, MEMBERS } = require('./install-runtime-apply.cjs');

function tarEntry(name, bytes = Buffer.from('a'), type = '0', mode = 0o755) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write(mode.toString(8).padStart(7, '0') + '\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.fill(32, 148, 156);
  h.write(type, 156);
  h.write('ustar\0', 257);
  const checksum = [...h].reduce((a, b) => a + b, 0);
  h.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([h, bytes, Buffer.alloc(Math.ceil(bytes.length / 512) * 512 - bytes.length)]);
}
function fixture(extra = []) {
  return Buffer.concat([tarEntry('gvisor-bin/', Buffer.alloc(0), '5'), ...MEMBERS.map(name => tarEntry(name)), ...extra, Buffer.alloc(1024)]);
}
test('strict tar parser accepts only the complete fixed package layout', () => {
  const result = parseArchive(fixture());
  assert.equal(result.length, 7);
  assert.deepEqual(result.filter(x => !x.directory).map(x => x.name), MEMBERS);
});
for (const [name, type, mode] of [['../escape', '0', 0o755], ['/absolute', '0', 0o755], ['nested.zip', '0', 0o755],
  ['runsc', '2', 0o755], ['runsc', '1', 0o755], ['runsc', '3', 0o755], ['runsc', '0', 0o4755], ['runsc', '0', 0o777]]) {
  test(`reject tar member ${name} type=${type} mode=${mode.toString(8)}`, () => {
    assert.throws(() => parseArchive(fixture([tarEntry(name, Buffer.from('a'), type, mode)])));
  });
}
test('reject duplicate member', () => assert.throws(() => parseArchive(fixture([tarEntry('runsc')]))));
test('reject corrupt header checksum and trailing payload', () => {
  const corrupt = fixture();
  corrupt[0] ^= 1;
  assert.throws(() => parseArchive(corrupt), /header/);
  const trailing = Buffer.concat([fixture(), Buffer.alloc(512, 1)]);
  assert.throws(() => parseArchive(trailing), /trailing/);
});
test('reject missing terminator or missing sidecars', () => {
  assert.throws(() => parseArchive(fixture().subarray(0, fixture().length - 1024)), /incomplete/);
  assert.throws(() => parseArchive(Buffer.concat([tarEntry('runsc'), Buffer.alloc(1024)])), /incomplete/);
});
test('remote quoting makes shell metacharacters literal', () => {
  assert.equal(quote("a'b;$(id)"), "'a'\\''b;$(id)'");
});
