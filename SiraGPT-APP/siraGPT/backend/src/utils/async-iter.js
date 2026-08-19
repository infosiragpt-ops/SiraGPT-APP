'use strict';

/**
 * async-iter — small set of operators over AsyncIterables. Pairs
 * with the SSE reassembler (#17), NDJSON parser (#62), and the
 * tool-call assembler (#19): those produce streams of values; these
 * are the lazy operators you compose on top without buffering the
 * whole stream into memory.
 *
 * Public API (all return AsyncIterable unless noted):
 *   asyncMap(iter, fn)
 *   asyncFilter(iter, predicate)
 *   asyncTake(iter, n)            — first N items
 *   asyncSkip(iter, n)            — drop first N items
 *   asyncBatch(iter, size)        — buckets into arrays of `size`
 *   toAsync(iterable)             — convert sync iterable
 *
 * Terminal:
 *   asyncReduce(iter, fn, initial) → Promise<value>
 *   asyncForEach(iter, fn)         → Promise<void>
 *   asyncCollect(iter)             → Promise<value[]>
 *   asyncCount(iter)               → Promise<number>
 */

function isAsyncIterable(x) {
  return x != null && typeof x[Symbol.asyncIterator] === 'function';
}

function isSyncIterable(x) {
  return x != null && typeof x[Symbol.iterator] === 'function';
}

async function* toAsync(iterable) {
  if (isAsyncIterable(iterable)) { for await (const v of iterable) yield v; return; }
  if (isSyncIterable(iterable)) { for (const v of iterable) yield v; return; }
  throw new TypeError('toAsync: iterable required');
}

async function* asyncMap(iter, fn) {
  if (typeof fn !== 'function') throw new TypeError('asyncMap: fn required');
  let i = 0;
  for await (const v of toAsync(iter)) yield await fn(v, i++);
}

async function* asyncFilter(iter, predicate) {
  if (typeof predicate !== 'function') throw new TypeError('asyncFilter: predicate required');
  let i = 0;
  for await (const v of toAsync(iter)) if (await predicate(v, i++)) yield v;
}

async function* asyncTake(iter, n) {
  const cap = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (cap === 0) return;
  let count = 0;
  for await (const v of toAsync(iter)) {
    yield v;
    count += 1;
    if (count >= cap) return;
  }
}

async function* asyncSkip(iter, n) {
  const drop = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  let i = 0;
  for await (const v of toAsync(iter)) {
    if (i++ < drop) continue;
    yield v;
  }
}

async function* asyncBatch(iter, size) {
  const cap = Number.isFinite(size) && size > 0 ? Math.floor(size) : 1;
  let buf = [];
  for await (const v of toAsync(iter)) {
    buf.push(v);
    if (buf.length === cap) { yield buf; buf = []; }
  }
  if (buf.length > 0) yield buf;
}

async function asyncReduce(iter, fn, initial) {
  if (typeof fn !== 'function') throw new TypeError('asyncReduce: fn required');
  let acc = initial;
  let started = arguments.length >= 3;
  let i = 0;
  for await (const v of toAsync(iter)) {
    if (!started) { acc = v; started = true; i += 1; continue; }
    acc = await fn(acc, v, i++);
  }
  if (!started) throw new TypeError('asyncReduce: empty iterable with no initial value');
  return acc;
}

async function asyncForEach(iter, fn) {
  if (typeof fn !== 'function') throw new TypeError('asyncForEach: fn required');
  let i = 0;
  for await (const v of toAsync(iter)) await fn(v, i++);
}

async function asyncCollect(iter) {
  const out = [];
  for await (const v of toAsync(iter)) out.push(v);
  return out;
}

async function asyncCount(iter) {
  let n = 0;
  for await (const _ of toAsync(iter)) n += 1;
  return n;
}

module.exports = {
  toAsync,
  asyncMap,
  asyncFilter,
  asyncTake,
  asyncSkip,
  asyncBatch,
  asyncReduce,
  asyncForEach,
  asyncCollect,
  asyncCount,
  isAsyncIterable,
  isSyncIterable,
};
