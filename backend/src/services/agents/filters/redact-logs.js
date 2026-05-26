'use strict';

const { redact } = require('../audit-log');

module.exports = {
  id: 'redact-logs',
  priority: 20,
  enabled: true,
  options: {},
  async pre(ctx) {
    ctx.logSafePrompt = typeof ctx.prompt === 'string' ? redact(ctx.prompt) : ctx.prompt;
    return null;
  },
  async post(ctx) {
    if (typeof ctx.response === 'string') {
      ctx.logSafeResponse = redact(ctx.response);
    }
    return null;
  },
};
