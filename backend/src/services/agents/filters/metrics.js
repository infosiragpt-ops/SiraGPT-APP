'use strict';

const { audit } = require('../audit-log');

module.exports = {
  id: 'metrics',
  priority: 30,
  enabled: true,
  options: {},
  async pre(ctx) {
    ctx._metricsStart = Date.now();
    return null;
  },
  async post(ctx) {
    const durationMs = ctx._metricsStart ? Date.now() - ctx._metricsStart : null;
    const promptLen = typeof ctx.prompt === 'string' ? ctx.prompt.length : 0;
    const responseLen = typeof ctx.response === 'string' ? ctx.response.length : 0;
    const approxTokens = Math.ceil((promptLen + responseLen) / 4);
    try {
      audit({
        event: 'filter_pipeline_metrics',
        scope: ctx.scope || null,
        userId: ctx.userId || null,
        model: ctx.model || null,
        provider: ctx.provider || null,
        durationMs,
        promptChars: promptLen,
        responseChars: responseLen,
        approxTokens,
        aborted: !!ctx.aborted,
        abortReason: ctx.abortReason || null,
      });
    } catch (_) { /* never throw from a filter */ }
    return null;
  },
};
