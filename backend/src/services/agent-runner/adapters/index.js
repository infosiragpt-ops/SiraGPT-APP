'use strict';

/**
 * Vendor adapters → SiraAction[] (F7.3).
 *
 * Model-agnostic: the CU-loop never branches on a vendor SDK. Call
 * `toSiraActions(payload)` after the LLM returns.
 */

const {
  SIRA_ACTION_TYPES,
  normalizeSiraAction,
  normalizeSiraActions,
  scalePoint,
  isSiraActionType,
} = require('./sira-action');
const { anthropicToSira } = require('./anthropic');
const { openaiToSira } = require('./openai');
const { geminiToSira } = require('./gemini');

function looksAnthropic(item) {
  if (!item || typeof item !== 'object') return false;
  const a = String(item.action || '').toLowerCase();
  return Boolean(item.coordinate)
    || /^(left_click|right_click|middle_click|mouse_move|left_click_drag|double_click)$/.test(a);
}

function looksGemini(item) {
  if (!item || typeof item !== 'object') return false;
  const n = String(item.name || '').toLowerCase();
  return /_(at|text|combination|document|drop|seconds|browser)$/.test(n)
    || /^(click_at|type_text_at|hover_at|scroll_at|key_combination|open_web_browser)$/.test(n);
}

function looksOpenAi(item) {
  if (!item || typeof item !== 'object') return false;
  const t = String(item.type || '').toLowerCase();
  return t === 'keypress' || t === 'double_click'
    || (t === 'click' && (item.x != null || item.y != null));
}

/**
 * Normalize any vendor (or already-Sira) payload to SiraAction[].
 * `hint` may be 'anthropic' | 'openai' | 'gemini' | 'sira'. Never a model id.
 */
function toSiraActions(raw, opts = {}) {
  const hint = String(opts.hint || opts.vendor || '').trim().toLowerCase();
  if (hint === 'anthropic') return anthropicToSira(raw, opts);
  if (hint === 'openai' || hint === 'cua') return openaiToSira(raw, opts);
  if (hint === 'gemini') return geminiToSira(raw, opts);
  if (hint === 'sira') return normalizeSiraActions(raw, opts);

  const first = Array.isArray(raw) ? raw[0] : (raw && raw.actions && raw.actions[0]) || raw;
  if (looksAnthropic(first)) return anthropicToSira(raw, opts);
  if (looksGemini(first)) return geminiToSira(raw, opts);
  if (looksOpenAi(first)) return openaiToSira(raw, opts);
  const sira = normalizeSiraActions(raw, opts);
  if (sira.length) return sira;
  const openai = openaiToSira(raw, opts);
  if (openai.length) return openai;
  const anthropic = anthropicToSira(raw, opts);
  if (anthropic.length) return anthropic;
  return geminiToSira(raw, opts);
}

module.exports = {
  SIRA_ACTION_TYPES,
  isSiraActionType,
  normalizeSiraAction,
  normalizeSiraActions,
  scalePoint,
  toSiraActions,
  anthropicToSira,
  openaiToSira,
  geminiToSira,
};
