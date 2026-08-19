'use strict';

const buckets = new Map();

function _bucket(key, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start >= windowMs) {
    b = { start: now, count: 0 };
    buckets.set(key, b);
  }
  return b;
}

module.exports = {
  id: 'rate-limit',
  priority: 10,
  enabled: true,
  options: { windowMs: 60_000, max: 60 },
  async pre(ctx, options) {
    const userId = ctx.userId || ctx.user?.id || ctx.req?.user?.id || 'anon';
    const opts = options || this.options;
    const b = _bucket(`user:${userId}`, opts.windowMs);
    b.count += 1;
    if (b.count > opts.max) {
      return {
        abort: true,
        status: 429,
        reason: 'filter.rate_limit',
        message: `Rate limit exceeded: ${opts.max} requests / ${opts.windowMs}ms`,
        retryAfterMs: opts.windowMs - (Date.now() - b.start),
      };
    }
    return null;
  },
  _resetForTests() {
    buckets.clear();
  },
};
