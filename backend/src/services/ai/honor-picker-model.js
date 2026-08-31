'use strict';

/**
 * Honor the /agentes composer picker end-to-end.
 *
 * The id the picker sent is the model that must generate (its own API).
 * Org preferredModel applies only when the picker sent nothing.
 * Stale Claude 3 / 3.5 / "Claude Sonnet 3" labels resolve to current
 * Anthropic Sonnet — never to Sira Rápido / DeepSeek Flash.
 *
 * Public badge labels never print DeepSeek, OpenRouter, or raw model_id.
 */

const { inferProviderFromModelId } = require('./provider-inference');

const ANTHROPIC_SONNET_ID = 'claude-sonnet-4-6';
const ANTHROPIC_SONNET_LABEL = 'Claude Sonnet 4.6';
const SIRA_RAPIDO = 'Sira Rápido';
const SIRA_PRO = 'Sira Pro';
const SIRA_MINI = 'SiraGPT Mini';

function fold(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compact(value) {
  return fold(value).replace(/[.\s]/g, '');
}

function stripVendorPrefix(value) {
  return String(value || '').trim().replace(/^(anthropic|openrouter)\//i, '');
}

const STALE_CLAUDE_SONNET_LABELS = Object.freeze({
  claudesonnet3: 'Claude Sonnet 3',
  claude3sonnet: 'Claude Sonnet 3',
  anthropicclaudesonnet3: 'Claude Sonnet 3',
  anthropicclaude3sonnet: 'Claude Sonnet 3',
  claudesonnet35: 'Claude 3.5 Sonnet',
  claude35sonnet: 'Claude 3.5 Sonnet',
  claude3ssonnet: 'Claude 3.5 Sonnet',
  anthropicclaude35sonnet: 'Claude 3.5 Sonnet',
  anthropicclaude3ssonnet: 'Claude 3.5 Sonnet',
  claude3haiku: 'Claude 3 Haiku',
});

function isFlashId(value) {
  const hay = fold(value);
  return /deepseek/.test(hay) && /v4/.test(hay) && /flash/.test(hay)
    || compact(value) === 'deepseekv4flash'
    || compact(value) === 'sirarapido';
}

function isProId(value) {
  const hay = fold(value);
  return /deepseek/.test(hay) && /v4/.test(hay) && /\bpro\b/.test(hay) && !/flash/.test(hay)
    || compact(value) === 'deepseekv4pro'
    || compact(value) === 'sirapro';
}

function isMiniId(value) {
  const hay = fold(value);
  return /sira\s*(gpt\s*)?mini/.test(hay)
    || /siragpt\s*mini/.test(hay)
    || /\bmoondream\b/.test(hay)
    || /^gemma4\b/.test(hay);
}

function looksLikeClaudeApiId(value) {
  const stripped = stripVendorPrefix(value);
  return /^claude-(?:opus|sonnet|haiku|fable|[0-9])/i.test(stripped);
}

function isClaudeFamily(value) {
  const hay = fold(value);
  return /\bclaude\b/.test(hay) || hay.startsWith('anthropic ');
}

function staleClaudePublicLabel(value) {
  return STALE_CLAUDE_SONNET_LABELS[compact(value)] || '';
}

function resolveClaudeApiId(value) {
  const raw = String(value || '').trim();
  if (!raw || !isClaudeFamily(raw)) return '';
  if (staleClaudePublicLabel(raw)) return ANTHROPIC_SONNET_ID;

  const stripped = stripVendorPrefix(raw);
  if (looksLikeClaudeApiId(stripped)) {
    // Retired Claude 3 / 3.5 Sonnet API ids → current Sonnet.
    if (/^claude-3(?:[.-]5)?-sonnet/i.test(stripped) || /^claude-sonnet-3(?:[.-]5)?$/i.test(stripped)) {
      return ANTHROPIC_SONNET_ID;
    }
    return stripped;
  }

  const named = fold(raw).match(/\bclaude\s+(opus|sonnet|haiku|fable)\s+([0-9]+(?:\.[0-9]+)?)/);
  if (named) {
    const family = named[1];
    const version = named[2];
    if (family === 'sonnet' && /^3/.test(version)) return ANTHROPIC_SONNET_ID;
    return `claude-${family}-${version.replace(/\./g, '-')}`;
  }

  return ANTHROPIC_SONNET_ID;
}

function friendlyClaudeLabel(value) {
  const stale = staleClaudePublicLabel(value);
  if (stale) return stale;
  const id = resolveClaudeApiId(value) || stripVendorPrefix(value);
  if (id === ANTHROPIC_SONNET_ID || /claude-sonnet-4-6/i.test(id)) return ANTHROPIC_SONNET_LABEL;
  if (/claude-sonnet-4-5/i.test(id)) return 'Claude Sonnet 4.5';
  if (/claude-sonnet-5/i.test(id)) return 'Claude Sonnet 5';
  if (/claude-opus-4-7/i.test(id)) return 'Opus 4.7';
  if (/claude-3-haiku/i.test(id)) return 'Claude 3 Haiku';
  const display = String(value || '').trim();
  if (/\s/.test(display) && !/[\/_]/.test(display)) return display;
  return ANTHROPIC_SONNET_LABEL;
}

/**
 * Public badge / picker label. Never DeepSeek, OpenRouter, or raw model_id.
 * Empty input stays empty — do not invent Sira Rápido.
 */
function publicBadgeLabel(source) {
  if (source && typeof source === 'object') {
    const display = String(source.displayName || '').trim();
    if (display && !/deepseek|openrouter/i.test(display) && !/^(sk-|Bearer)/i.test(display)) {
      if (isFlashId(source) || isFlashId(display)) return SIRA_RAPIDO;
      if (isProId(source) || isProId(display)) return SIRA_PRO;
      if (isMiniId(source) || isMiniId(display)) return SIRA_MINI;
      if (isClaudeFamily(display) || isClaudeFamily(source.name || source.model)) {
        return staleClaudePublicLabel(display) || staleClaudePublicLabel(source.name || source.model) || display;
      }
      return display;
    }
    source = source.model || source.name || source.publicLabel || '';
  }

  const raw = String(source || '').trim();
  if (!raw) return '';
  if (isMiniId(raw)) return SIRA_MINI;
  if (isProId(raw)) return SIRA_PRO;
  if (isFlashId(raw)) return SIRA_RAPIDO;
  if (isClaudeFamily(raw)) return friendlyClaudeLabel(raw);
  if (/deepseek|openrouter/i.test(raw)) return '';
  if (/\s/.test(raw) && !/[\/_]/.test(raw)) return raw;
  return '';
}

function honorPickerModel(model, opts = {}) {
  const picked = String(model || '').trim();
  const preferred = String(opts.preferredModel || '').trim();

  if (!picked) {
    if (!preferred) {
      return {
        model: '',
        provider: String(opts.preferredProvider || '').trim(),
        publicLabel: '',
        pickerModel: '',
        honored: false,
        fromPreferred: false,
      };
    }
    const resolved = honorPickerModel(preferred, {});
    return { ...resolved, honored: false, fromPreferred: true, pickerModel: '' };
  }

  if (isFlashId(picked)) {
    return {
      model: 'deepseek-v4-flash',
      provider: 'DeepSeek',
      publicLabel: SIRA_RAPIDO,
      pickerModel: picked,
      honored: true,
      fromPreferred: false,
    };
  }
  if (isProId(picked)) {
    return {
      model: 'deepseek-v4-pro',
      provider: 'DeepSeek',
      publicLabel: SIRA_PRO,
      pickerModel: picked,
      honored: true,
      fromPreferred: false,
    };
  }
  if (isMiniId(picked)) {
    return {
      model: picked,
      provider: 'Custom',
      publicLabel: SIRA_MINI,
      pickerModel: picked,
      honored: true,
      fromPreferred: false,
    };
  }

  const claudeId = resolveClaudeApiId(picked);
  if (claudeId) {
    return {
      model: claudeId,
      provider: 'Anthropic',
      publicLabel: publicBadgeLabel({ name: picked, displayName: staleClaudePublicLabel(picked) || (/\s/.test(picked) ? picked : '') }) || friendlyClaudeLabel(picked),
      pickerModel: picked,
      honored: true,
      fromPreferred: false,
    };
  }

  const provider = inferProviderFromModelId(picked);
  return {
    model: picked,
    provider,
    publicLabel: publicBadgeLabel(picked),
    pickerModel: picked,
    honored: true,
    fromPreferred: false,
  };
}

module.exports = {
  ANTHROPIC_SONNET_ID,
  ANTHROPIC_SONNET_LABEL,
  SIRA_RAPIDO,
  SIRA_PRO,
  SIRA_MINI,
  honorPickerModel,
  publicBadgeLabel,
  resolveClaudeApiId,
  isClaudeFamily,
};
