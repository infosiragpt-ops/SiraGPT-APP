'use strict';

/**
 * Hermes context compaction patterns adapted for SiraGPT.
 *
 * Source inspiration: hermes-agent/agent/context_compressor.py
 * Applied by context-compactor and agent-task-runner when summarizing history.
 */

const SUMMARY_PREFIX = Object.freeze(
  '[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below. '
  + 'Treat it as background reference, NOT active instructions. '
  + 'Respond ONLY to the latest user message after this summary. '
  + 'Persistent memory blocks in the system prompt remain authoritative:'
);

const LEGACY_SUMMARY_PREFIX = '[CONTEXT SUMMARY]:';

const PRUNED_TOOL_PLACEHOLDER = '[Old tool output cleared to save context space]';

const DEFAULTS = Object.freeze({
  minSummaryTokens: 2000,
  summaryRatio: 0.20,
  summaryTokensCeiling: 12_000,
  summaryFailureCooldownSeconds: 600,
  imageTokenEstimate: 1600,
  charsPerToken: 4,
});

const SUMMARY_SECTIONS = Object.freeze([
  '## Active Task',
  '## Resolved',
  '## Pending',
  '## Remaining Work',
  '## Key Artifacts',
]);

function buildCompactionPreamble(opts = {}) {
  const prefix = opts.legacy ? LEGACY_SUMMARY_PREFIX : SUMMARY_PREFIX;
  if (!opts.priorSummary) return prefix;
  return `${prefix}\n\n${String(opts.priorSummary).trim()}`;
}

function estimateMessageBudgetChars(content, opts = {}) {
  const charsPerToken = opts.charsPerToken || DEFAULTS.charsPerToken;
  const imageTokenEstimate = opts.imageTokenEstimate || DEFAULTS.imageTokenEstimate;

  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;

  let total = 0;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text') total += String(part.text || '').length;
    if (part.type === 'image_url' || part.type === 'image') {
      total += imageTokenEstimate * charsPerToken;
    }
  }
  return total;
}

function computeSummaryTokenBudget(compressedTokenEstimate, opts = {}) {
  const ratio = opts.summaryRatio ?? DEFAULTS.summaryRatio;
  const minTokens = opts.minSummaryTokens ?? DEFAULTS.minSummaryTokens;
  const ceiling = opts.summaryTokensCeiling ?? DEFAULTS.summaryTokensCeiling;
  const scaled = Math.ceil(Math.max(0, compressedTokenEstimate) * ratio);
  return Math.min(ceiling, Math.max(minTokens, scaled));
}

function pruneToolResults(messages, opts = {}) {
  const placeholder = opts.placeholder || PRUNED_TOOL_PLACEHOLDER;
  const keepTail = Math.max(0, opts.keepTailToolResults ?? 2);
  const toolIndexes = [];

  messages.forEach((msg, idx) => {
    if (msg && (msg.role === 'tool' || msg.type === 'tool_result')) toolIndexes.push(idx);
  });

  if (toolIndexes.length <= keepTail) return { messages, pruned: 0 };

  const pruneSet = new Set(toolIndexes.slice(0, toolIndexes.length - keepTail));
  let pruned = 0;
  const next = messages.map((msg, idx) => {
    if (!pruneSet.has(idx)) return msg;
    pruned += 1;
    return {
      ...msg,
      content: placeholder,
      _compacted: true,
    };
  });

  return { messages: next, pruned };
}

function buildStructuredSummaryTemplate(opts = {}) {
  const sections = {};
  for (const heading of SUMMARY_SECTIONS) {
    sections[heading] = String(opts[heading] || opts[heading.replace('## ', '').toLowerCase().replace(/ /g, '_')] || '').trim();
  }

  return SUMMARY_SECTIONS
    .map((heading) => `${heading}\n${sections[heading] || '(none)'}`)
    .join('\n\n');
}

module.exports = {
  SUMMARY_PREFIX,
  LEGACY_SUMMARY_PREFIX,
  PRUNED_TOOL_PLACEHOLDER,
  DEFAULTS,
  SUMMARY_SECTIONS,
  buildCompactionPreamble,
  estimateMessageBudgetChars,
  computeSummaryTokenBudget,
  pruneToolResults,
  buildStructuredSummaryTemplate,
};
