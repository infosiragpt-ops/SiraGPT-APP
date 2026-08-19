/**
 * Redis probe — pings a Redis client and reports latency.
 * The redis client is injected (ioredis or node-redis style: `.ping()`).
 */

'use strict';

const { Probe, CATEGORY } = require('../probe');

function createRedisProbe({
  client,
  name = 'redis',
  category = CATEGORY.DEGRADED,
  timeoutMs = 1000,
  ttlMs = 5000,
} = {}) {
  if (!client || typeof client.ping !== 'function') {
    throw new TypeError('createRedisProbe: a Redis client with .ping() is required');
  }

  return new Probe({
    name,
    category,
    timeoutMs,
    ttlMs,
    check: async () => {
      const t0 = Date.now();
      const reply = await client.ping();
      const elapsedMs = Date.now() - t0;
      const ok = reply === 'PONG' || reply === 'pong' || reply === true;
      return {
        status: ok ? 'pass' : 'warn',
        details: { reply: String(reply).slice(0, 32), driverElapsedMs: elapsedMs },
      };
    },
  });
}

module.exports = { createRedisProbe };
