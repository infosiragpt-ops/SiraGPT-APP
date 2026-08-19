/**
 * Memory probe — inspects RSS and heap usage of the current process.
 * Warns/fails based on absolute RSS thresholds (bytes) so the probe does
 * not require knowledge of the container's memory cgroup.
 */

'use strict';

const { Probe, CATEGORY } = require('../probe');

function createMemoryProbe({
  name = 'memory',
  category = CATEGORY.DEGRADED,
  timeoutMs = 250,
  ttlMs = 5000,
  warnRssBytes = 1.5 * 1024 * 1024 * 1024,  // 1.5 GiB
  failRssBytes = 3   * 1024 * 1024 * 1024,  // 3 GiB
  memoryUsage = process.memoryUsage,
} = {}) {
  return new Probe({
    name,
    category,
    timeoutMs,
    ttlMs,
    check: () => {
      const m = memoryUsage();
      let status = 'pass';
      if (m.rss >= failRssBytes) status = 'fail';
      else if (m.rss >= warnRssBytes) status = 'warn';
      return {
        status,
        details: {
          rss: m.rss,
          heapUsed: m.heapUsed,
          heapTotal: m.heapTotal,
          external: m.external,
          arrayBuffers: m.arrayBuffers,
          warnRssBytes,
          failRssBytes,
        },
      };
    },
  });
}

module.exports = { createMemoryProbe };
