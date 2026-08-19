'use strict';

/**
 * Example opt-in filter. Disabled by default. Demonstrates that adding
 * cross-cutting behaviour is one self-contained module under
 * `services/agents/filters/` — no edits to the runner or routes.
 *
 * In a real implementation `translate` would call a translation
 * provider; we keep it pure so the test suite stays hermetic.
 */
module.exports = {
  id: 'translate-prompt',
  priority: 5,
  enabled: false,
  options: { targetLanguage: 'en' },
  async pre(ctx, options) {
    const opts = options || this.options;
    if (typeof ctx.prompt !== 'string' || !ctx.prompt) return null;
    ctx.translatedFromLanguage = ctx.language || 'unknown';
    ctx.translatedToLanguage = opts.targetLanguage;
    ctx.prompt = `[translated→${opts.targetLanguage}] ${ctx.prompt}`;
    return null;
  },
};
