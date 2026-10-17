'use strict';

/**
 * Bytes for pdf-parse (pdf.js 1.10) that it can always read.
 *
 * pdf.js 1.10 copies its input with `new value.constructor(value)`. For a
 * Node Buffer that is `new Buffer(buf)`, which takes a small copy (under half
 * of Buffer.poolSize: 4 KB on Node 22, 32 KB on Node 24) from the shared pool
 * at a non-zero byteOffset. Its Stream.makeSubStream then reads
 * `this.bytes.buffer` from 0, ignoring that offset, so every object lookup
 * lands on other pool bytes and a small PDF fails with «bad XRef entry»
 * depending on where the pool happened to be.
 *
 * A plain Uint8Array that starts at byte 0 of its own ArrayBuffer avoids both:
 * its copy is a fresh Uint8Array, and without a copy the offset is already 0.
 * An exact Buffer becomes a view (no copy); a slice of a larger buffer is
 * copied (only the pooled small ones and sub-slices are).
 */
function toPdfJsData(data) {
  if (!(data instanceof Uint8Array)) return data;
  if (data.byteOffset === 0 && data.buffer.byteLength === data.byteLength) {
    return new Uint8Array(data.buffer, 0, data.byteLength);
  }
  return new Uint8Array(data);
}

module.exports = { toPdfJsData };
