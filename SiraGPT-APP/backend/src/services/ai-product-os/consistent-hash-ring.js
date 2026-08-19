'use strict';

/**
 * consistent-hash-ring — classic consistent-hash ring (Karger et al.
 * 1997) with virtual nodes (vnodes) for smooth load distribution.
 * Pairs with the per-tenant cache namespace (#9) and token-bucket
 * (#31): those bound a single replica's resources, this one decides
 * *which* replica owns a given key.
 *
 * Adding or removing a node only reshuffles 1/N of keys on average,
 * which is the whole point: when an upstream provider key gets
 * rotated, only ~1/N of tenants see a cache miss.
 *
 * Public API:
 *   const ring = createConsistentHashRing({ vnodesPerNode = 64 })
 *   ring.addNode(nodeId)
 *   ring.removeNode(nodeId)
 *   ring.locate(key)              → nodeId
 *   ring.locateN(key, n)          → [nodeId, ...] (replication / fallback)
 *   ring.nodes()                  → list of node ids
 *   ring.snapshot()               → ring stats
 */

const { createHash } = require('node:crypto');

const DEFAULT_VNODES = 64;

function hash32(input) {
  // First 4 bytes of sha256 → unsigned 32-bit. Good distribution,
  // avoids loading a hash library.
  return createHash('sha256').update(String(input)).digest().readUInt32BE(0);
}

function lowerBound(arr, target) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].h < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function createConsistentHashRing(opts = {}) {
  const vnodesPerNode = Number.isInteger(opts.vnodesPerNode) && opts.vnodesPerNode > 0
    ? opts.vnodesPerNode
    : DEFAULT_VNODES;

  /** Sorted array of { h, node }. */
  const ring = [];
  const nodes = new Set();

  function rebuild() {
    ring.length = 0;
    for (const node of nodes) {
      for (let v = 0; v < vnodesPerNode; v++) {
        ring.push({ h: hash32(`${node}#${v}`), node });
      }
    }
    ring.sort((a, b) => a.h - b.h);
  }

  function addNode(nodeId) {
    if (typeof nodeId !== 'string' || !nodeId) throw new TypeError('addNode: nodeId required');
    if (nodes.has(nodeId)) return false;
    nodes.add(nodeId);
    rebuild();
    return true;
  }

  function removeNode(nodeId) {
    if (!nodes.has(nodeId)) return false;
    nodes.delete(nodeId);
    rebuild();
    return true;
  }

  function locate(key) {
    if (ring.length === 0) return null;
    if (key == null) throw new TypeError('locate: key required');
    const h = hash32(key);
    const i = lowerBound(ring, h);
    return ring[i === ring.length ? 0 : i].node;
  }

  function locateN(key, n) {
    if (ring.length === 0) return [];
    const want = Math.max(1, Math.min(n || 1, nodes.size));
    const out = [];
    const seen = new Set();
    let i = lowerBound(ring, hash32(key));
    for (let step = 0; step < ring.length && out.length < want; step++) {
      const slot = ring[(i + step) % ring.length];
      if (!seen.has(slot.node)) {
        seen.add(slot.node);
        out.push(slot.node);
      }
    }
    return out;
  }

  function snapshot() {
    return {
      nodes: nodes.size,
      vnodesPerNode,
      ringSize: ring.length,
    };
  }

  return {
    addNode,
    removeNode,
    locate,
    locateN,
    nodes: () => [...nodes],
    snapshot,
  };
}

module.exports = {
  createConsistentHashRing,
  DEFAULT_VNODES,
};
