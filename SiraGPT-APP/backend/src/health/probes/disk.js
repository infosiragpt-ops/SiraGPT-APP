/**
 * Disk probe — checks free space at a given path using statfs.
 * Reports a warning when usage crosses `warnPct`, a failure beyond `failPct`.
 */

'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const { Probe, CATEGORY } = require('../probe');

function createDiskProbe({
  path = os.tmpdir(),
  name = 'disk',
  category = CATEGORY.DEGRADED,
  timeoutMs = 1000,
  ttlMs = 10_000,
  warnPct = 0.85,
  failPct = 0.95,
  statfs,
} = {}) {
  const stat = statfs || fs.statfs;
  if (typeof stat !== 'function') {
    throw new Error('createDiskProbe: fs.statfs is unavailable on this runtime');
  }

  return new Probe({
    name,
    category,
    timeoutMs,
    ttlMs,
    check: async () => {
      const s = await stat(path);
      const total = Number(s.blocks) * Number(s.bsize);
      const free  = Number(s.bavail) * Number(s.bsize);
      if (!total || !Number.isFinite(total)) {
        return { status: 'warn', message: 'disk size unavailable', details: { path } };
      }
      const used = total - free;
      const usedPct = used / total;
      let status = 'pass';
      if (usedPct >= failPct) status = 'fail';
      else if (usedPct >= warnPct) status = 'warn';
      return {
        status,
        details: {
          path,
          totalBytes: total,
          freeBytes: free,
          usedBytes: used,
          usedPct: Number(usedPct.toFixed(4)),
          warnPct,
          failPct,
        },
      };
    },
  });
}

module.exports = { createDiskProbe };
