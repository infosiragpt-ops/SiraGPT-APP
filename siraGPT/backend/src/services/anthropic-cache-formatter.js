'use strict';

const ANTHROPIC_CACHE_BREAKPOINT_LIMIT = 4;

const ANTHROPIC_MODEL_PATTERN = /(?:^|\/)(?:claude|anthropic)/i;
const ANTHROPIC_OPENROUTER_PATTERN = /^anthropic\/|claude/i;

function shouldUseAnthropicCache(provider, model) {
  const p = String(provider || '').trim().toLowerCase();
  const m = String(model || '').trim().toLowerCase();
  if (!m) return false;
  if (p === 'anthropic') return true;
  if (p === 'openrouter' && ANTHROPIC_OPENROUTER_PATTERN.test(m)) return true;
  if (!p && ANTHROPIC_MODEL_PATTERN.test(m)) return true;
  return false;
}

function normalizeBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks
    .map((b) => {
      if (b == null) return null;
      if (typeof b === 'string') {
        const trimmed = b.trim();
        if (!trimmed) return null;
        return { kind: 'text', text: trimmed, cacheable: false };
      }
      const text = typeof b.text === 'string' ? b.text : (typeof b.content === 'string' ? b.content : '');
      const trimmed = text.trim();
      if (!trimmed) return null;
      return {
        kind: typeof b.kind === 'string' && b.kind ? b.kind : 'text',
        text: trimmed,
        cacheable: Boolean(b.cacheable),
      };
    })
    .filter(Boolean);
}

function buildSystemContentBlocks(blocks) {
  const normalized = normalizeBlocks(blocks);
  if (normalized.length === 0) return [];

  const contentBlocks = normalized.map((b) => ({ type: 'text', text: b.text, _cacheable: b.cacheable }));

  let lastCacheableIdx = -1;
  for (let i = 0; i < contentBlocks.length; i += 1) {
    if (contentBlocks[i]._cacheable) lastCacheableIdx = i;
  }

  const cacheableEndIndices = [];
  if (lastCacheableIdx !== -1) {
    let runEnd = -1;
    for (let i = 0; i <= lastCacheableIdx; i += 1) {
      if (contentBlocks[i]._cacheable) {
        runEnd = i;
      } else if (runEnd !== -1) {
        cacheableEndIndices.push(runEnd);
        runEnd = -1;
      }
    }
    if (runEnd !== -1) cacheableEndIndices.push(runEnd);
  }

  const breakpointIndices = cacheableEndIndices.slice(-ANTHROPIC_CACHE_BREAKPOINT_LIMIT);
  const breakpointSet = new Set(breakpointIndices);

  return contentBlocks.map((b, idx) => {
    const out = { type: 'text', text: b.text };
    if (breakpointSet.has(idx)) {
      out.cache_control = { type: 'ephemeral' };
    }
    return out;
  });
}

function formatSystemMessageWithCache(blocks) {
  const content = buildSystemContentBlocks(blocks);
  return { role: 'system', content };
}

function countCacheBreakpoints(systemMessage) {
  if (!systemMessage || !Array.isArray(systemMessage.content)) return 0;
  return systemMessage.content.reduce((acc, block) => (
    block && block.cache_control && block.cache_control.type === 'ephemeral' ? acc + 1 : acc
  ), 0);
}

function applyAnthropicCacheToMessages(messages, blocks, { provider, model } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return { messages, applied: false, breakpoints: 0 };
  if (!shouldUseAnthropicCache(provider, model)) return { messages, applied: false, breakpoints: 0 };
  const normalized = normalizeBlocks(blocks);
  if (normalized.length === 0) return { messages, applied: false, breakpoints: 0 };

  const next = messages.slice();
  const first = next[0];
  if (!first || first.role !== 'system') return { messages, applied: false, breakpoints: 0 };

  const newSystem = formatSystemMessageWithCache(normalized);
  next[0] = newSystem;
  return { messages: next, applied: true, breakpoints: countCacheBreakpoints(newSystem) };
}

module.exports = {
  ANTHROPIC_CACHE_BREAKPOINT_LIMIT,
  shouldUseAnthropicCache,
  buildSystemContentBlocks,
  formatSystemMessageWithCache,
  applyAnthropicCacheToMessages,
  countCacheBreakpoints,
};
