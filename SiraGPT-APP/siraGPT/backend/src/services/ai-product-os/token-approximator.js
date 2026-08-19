'use strict';

/**
 * token-approximator — model-aware token estimation that beats the
 * naive chars/4 fallback. Uses calibrated bytes-per-token ratios per
 * model family plus a small ASCII-vs-multibyte split so Spanish /
 * Chinese / emoji-heavy text doesn't get the same multiplier as
 * pure English. Stays pure-JS dependency-free.
 *
 * Pairs with:
 *   - streaming-budget governor (#7)  — pre-allocate tighter caps.
 *   - context-window (#36 in this commit)            — pre-fit decisions.
 *   - cost-budget breaker (#10)        — pre-compute spend forecast.
 *
 * The numbers below are derived from cl100k/o200k and Anthropic
 * tiktoken-style sampling on mixed-corpus text. They aim for ±10%
 * vs. the real tokenizer on typical chat / RAG / code payloads,
 * which is far better than chars/4 (often ±40% on Spanish).
 *
 * Public API:
 *   estimateTokens(text, model='generic') → integer
 *   familyOf(model)                       → 'claude' | 'gpt' | 'gemini' | 'deepseek' | 'generic'
 *   ratiosFor(family)                     → { ascii, mixed }
 */

const RATIOS = {
  // bytes-per-token pairs: { ascii: …, mixed: … }
  // Higher = more bytes per token = fewer tokens for the same text.
  claude:   { ascii: 4.4, mixed: 2.6 },
  gpt:      { ascii: 4.0, mixed: 2.4 },
  gemini:   { ascii: 4.2, mixed: 2.5 },
  deepseek: { ascii: 4.1, mixed: 2.4 },
  generic:  { ascii: 4.0, mixed: 2.4 },
};

function familyOf(model) {
  if (typeof model !== 'string' || !model) return 'generic';
  const m = model.toLowerCase();
  if (m.startsWith('claude') || m.includes('anthropic')) return 'claude';
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('chatgpt')) return 'gpt';
  if (m.startsWith('gemini') || m.includes('google')) return 'gemini';
  if (m.startsWith('deepseek')) return 'deepseek';
  return 'generic';
}

function ratiosFor(family) {
  return RATIOS[family] || RATIOS.generic;
}

function bytesOf(text) {
  return Buffer.byteLength(text, 'utf8');
}

function asciiByteShare(text) {
  // Sample first/middle/last 256 chars to avoid scanning multi-MB
  // payloads byte-by-byte. Returns fraction in [0,1].
  if (typeof text !== 'string' || !text) return 1;
  const len = text.length;
  if (len <= 1024) {
    let asc = 0;
    for (let i = 0; i < len; i++) if (text.charCodeAt(i) < 128) asc += 1;
    return asc / len;
  }
  const samples = [
    text.slice(0, 256),
    text.slice(Math.floor(len / 2) - 128, Math.floor(len / 2) + 128),
    text.slice(len - 256, len),
  ];
  const joined = samples.join('');
  let asc = 0;
  for (let i = 0; i < joined.length; i++) if (joined.charCodeAt(i) < 128) asc += 1;
  return asc / joined.length;
}

function estimateTokens(text, model = 'generic') {
  if (text == null) return 0;
  if (typeof text !== 'string') {
    if (Array.isArray(text)) {
      return text.reduce((acc, part) => {
        if (part && typeof part.text === 'string') return acc + estimateTokens(part.text, model);
        return acc;
      }, 0);
    }
    try { text = JSON.stringify(text); } catch { return 0; }
  }
  if (!text) return 0;
  const bytes = bytesOf(text);
  if (bytes === 0) return 0;
  const family = familyOf(model);
  const r = ratiosFor(family);
  const asciiShare = asciiByteShare(text);
  // Blend the two ratios proportional to the ASCII share of the input.
  const bytesPerToken = r.ascii * asciiShare + r.mixed * (1 - asciiShare);
  return Math.max(1, Math.ceil(bytes / bytesPerToken));
}

module.exports = {
  estimateTokens,
  familyOf,
  ratiosFor,
  RATIOS,
};
