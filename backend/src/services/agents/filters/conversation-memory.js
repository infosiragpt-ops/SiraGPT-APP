'use strict';

module.exports = {
  id: 'conversation-memory',
  priority: 40,
  enabled: true,
  options: { thresholdMessages: 6, attachLastN: 3 },
  async pre(ctx, options) {
    const opts = options || this.options;
    const history = Array.isArray(ctx.history) ? ctx.history : [];
    if (history.length < opts.thresholdMessages) return null;
    const userTurns = history
      .filter((m) => m && (m.role === 'user' || m.role === 'USER'))
      .slice(-opts.attachLastN)
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .filter(Boolean);
    if (userTurns.length === 0) return null;
    ctx.extraContext = (ctx.extraContext || '') + '\n\n[Recent user turns]\n' + userTurns.map((t, i) => `(${i + 1}) ${t}`).join('\n');
    ctx.memoryAttached = userTurns.length;
    return null;
  },
};
