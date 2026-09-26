'use strict';

/**
 * Public model labels for the CONSTRUIR MVP: «DeepSeek V4 Flash» /
 * «DeepSeek V4 Pro» (original names). The legacy Sira aliases (Sira Rápido /
 * Sira Pro) are still accepted as input. Responses never echo a raw
 * vendor id / model_id.
 */

const {
  DEEPSEEK_FLASH_DISPLAY_NAME,
  DEEPSEEK_PRO_DISPLAY_NAME,
} = require('../ai/custom-provider-client');

const ALIAS_RAPIDO = DEEPSEEK_FLASH_DISPLAY_NAME;
const ALIAS_PRO = DEEPSEEK_PRO_DISPLAY_NAME;

const ALIAS_TABLE = Object.freeze({
  '': 'rapido',
  'deepseek v4 flash': 'rapido',
  'deepseek v4 pro': 'pro',
  'sira rapido': 'rapido',
  'sira rápido': 'rapido',
  'sira-rapido': 'rapido',
  'sira_rapido': 'rapido',
  sirarapido: 'rapido',
  rapido: 'rapido',
  rápido: 'rapido',
  flash: 'rapido',
  'sira pro': 'pro',
  'sira-pro': 'pro',
  'sira_pro': 'pro',
  sirapro: 'pro',
  pro: 'pro',
});

const PRO_RE = /(?:deepseek[-/_\s]?v?4[-/_\s]?pro|deepseek\s*v4\s*pro|v4[-_\s]?pro)/i;
const FLASH_RE = /(?:deepseek[-/_\s]?v?4[-/_\s]?flash|deepseek\s*v4\s*flash|v4[-_\s]?flash)/i;
const RAW_VENDOR_RE = /deepseek|openrouter|openai|gpt-?4|gpt-?5|o1\b|o3\b|ollama|huggingface|moondream/i;

function foldAlias(value) {
  return String(value == null ? '' : value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function looksLikeRawVendor(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return false;
  if (trimmed === ALIAS_RAPIDO || trimmed === ALIAS_PRO) return false;
  return RAW_VENDOR_RE.test(trimmed);
}

function resolveConstruirBrand(alias) {
  const raw = alias == null ? '' : String(alias);
  const folded = foldAlias(raw);
  if (Object.prototype.hasOwnProperty.call(ALIAS_TABLE, folded)) {
    const tier = ALIAS_TABLE[folded];
    return {
      brandLabel: tier === 'pro' ? ALIAS_PRO : ALIAS_RAPIDO,
      tier,
    };
  }
  if (PRO_RE.test(raw) && !FLASH_RE.test(raw)) {
    return { brandLabel: ALIAS_PRO, tier: 'pro' };
  }
  if (FLASH_RE.test(raw)) {
    return { brandLabel: ALIAS_RAPIDO, tier: 'rapido' };
  }
  if (looksLikeRawVendor(raw)) {
    return { brandLabel: ALIAS_RAPIDO, tier: 'rapido' };
  }
  const catalog = raw.trim();
  if (catalog) return { brandLabel: catalog.slice(0, 80), tier: 'catalog' };
  return { brandLabel: ALIAS_RAPIDO, tier: 'rapido' };
}

function assertNoVendorLeak(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  // The public model names are allowed; raw ids, aggregators and secrets are not.
  const scrubbed = text.split(ALIAS_RAPIDO).join('').split(ALIAS_PRO).join('');
  if (/deepseek|openrouter|sk-|gho_|ghs_|github_pat_/i.test(scrubbed)) {
    const err = new Error('vendor_or_secret_leak');
    err.code = 'E_CONTENT';
    throw err;
  }
  return payload;
}

module.exports = {
  ALIAS_RAPIDO,
  ALIAS_PRO,
  resolveConstruirBrand,
  looksLikeRawVendor,
  foldAlias,
  assertNoVendorLeak,
};
