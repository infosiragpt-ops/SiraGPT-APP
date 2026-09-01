'use strict';

/**
 * Honor the /agentes picker. The id the composer sent is the model that
 * generates on its own API. Never silent-swap Grok / Claude / GPT to Kimi
 * (or any other vendor). Org preferredModel applies only when the picker
 * sent nothing.
 */

const { resolveGenerateProvider } = require('./provider-inference');

const ANTHROPIC_SONNET_ID = 'claude-sonnet-4-6';

function fold(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripVendorPrefix(value) {
  return String(value || '').trim().replace(/^(anthropic|openrouter)\//i, '');
}

function remapStaleClaudeId(value) {
  const raw = String(value || '').trim();
  if (!raw || !/\bclaude\b/i.test(fold(raw))) return raw;
  const stripped = stripVendorPrefix(raw);
  if (/^claude-3(?:[.-]5)?-sonnet/i.test(stripped) || /^claude-sonnet-3(?:[.-]5)?$/i.test(stripped)) {
    return ANTHROPIC_SONNET_ID;
  }
  if (/claude\s+sonnet\s+3(?:\s|\.|$)/i.test(raw) || /claude\s+3(?:\.5)?\s+sonnet/i.test(raw)) {
    return ANTHROPIC_SONNET_ID;
  }
  return raw;
}

function honorPickerModel(model, opts = {}) {
  const picked = remapStaleClaudeId(String(model || '').trim());
  const requestedProvider = String(opts.provider || opts.requestedProvider || '').trim();
  const preferred = String(opts.preferredModel || '').trim();

  if (!picked) {
    if (!preferred) {
      return {
        model: '',
        provider: String(opts.preferredProvider || requestedProvider || '').trim(),
        honored: false,
        fromPreferred: false,
      };
    }
    const resolved = honorPickerModel(preferred, { provider: opts.preferredProvider });
    return { ...resolved, honored: false, fromPreferred: true };
  }

  return {
    model: picked,
    provider: resolveGenerateProvider(requestedProvider, picked),
    honored: true,
    fromPreferred: false,
  };
}

module.exports = {
  honorPickerModel,
  remapStaleClaudeId,
  ANTHROPIC_SONNET_ID,
};
