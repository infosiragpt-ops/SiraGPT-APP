'use strict';

/**
 * priority-queue — array-backed binary min-heap. O(log n) push and
 * pop, O(1) peek/size, stable ordering preserved across equal
 * priorities via an insertion counter (no FIFO-flip when two items
 * share the same key).
 *
 * Used as a primitive by schedulers (token-bulkhead #18 priority
 * lane), deadline-bound retries, top-K accumulators, and any other
 * "smallest/largest first" queue. Pure JS, no deps.
 *
 * Public API:
 *   const pq = createPriorityQueue({ key, max })
 *     key: (item) => number; default: identity
 *     max: boolean (default false → min-heap; true → max-heap)
 *   pq.push(item)        — O(log n)
 *   pq.pop()             — O(log n); returns undefined when empty
 *   pq.peek()            — O(1)
 *   pq.size()            — O(1)
 *   pq.clear()
 *   pq.toArray()         — heap array (NOT sorted; for inspection)
 *   pq.drain()           — pop everything in order, returns array
 */

function createPriorityQueue(opts = {}) {
  const userKey = typeof opts.key === 'function' ? opts.key : (x) => x;
  const isMax = Boolean(opts.max);
  // For a max-heap we negate the key so the same min-heap math works.
  const key = isMax ? (x) => -userKey(x) : userKey;

  /** Each entry: [priority, sequence, item]. sequence stabilizes ties. */
  const heap = [];
  let seq = 0;

  function compare(a, b) {
    if (a[0] !== b[0]) return a[0] - b[0];
    return a[1] - b[1];
  }

  function siftUp(i) {
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      if (compare(heap[i], heap[parent]) < 0) {
        const tmp = heap[i]; heap[i] = heap[parent]; heap[parent] = tmp;
        i = parent;
      } else return;
    }
  }

  function siftDown(i) {
    const n = heap.length;
    while (true) {
      const l = i * 2 + 1;
      const r = l + 1;
      let smallest = i;
      if (l < n && compare(heap[l], heap[smallest]) < 0) smallest = l;
      if (r < n && compare(heap[r], heap[smallest]) < 0) smallest = r;
      if (smallest === i) return;
      const tmp = heap[i]; heap[i] = heap[smallest]; heap[smallest] = tmp;
      i = smallest;
    }
  }

  function push(item) {
    const k = key(item);
    if (!Number.isFinite(k)) throw new TypeError('priority-queue: key must be finite number');
    heap.push([k, seq++, item]);
    siftUp(heap.length - 1);
  }

  function pop() {
    if (heap.length === 0) return undefined;
    const top = heap[0][2];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      siftDown(0);
    }
    return top;
  }

  function peek() {
    return heap.length === 0 ? undefined : heap[0][2];
  }

  function size() { return heap.length; }
  function clear() { heap.length = 0; seq = 0; }
  function toArray() { return heap.map((e) => e[2]); }
  function drain() {
    const out = [];
    while (heap.length > 0) out.push(pop());
    return out;
  }

  return { push, pop, peek, size, clear, toArray, drain };
}

module.exports = {
  createPriorityQueue,
};
