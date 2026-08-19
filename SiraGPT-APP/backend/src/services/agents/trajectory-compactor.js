'use strict';

/**
 * Trajectory compactor — Hermes trajectory_compressor.py adapted for SiraGPT.
 *
 * Compresses agent trajectories (arrays of turns) to fit a token budget while
 * preserving head/tail training signal. Deterministic offline utility for eval
 * harnesses and durable task exports.
 */

const { computeSummaryTokenBudget, buildStructuredSummaryTemplate } = require('./hermes-context-patterns');

const DEFAULT_TARGET_TOKENS = 16_000;
const CHARS_PER_TOKEN = 4;

function estimateTurnTokens(turn) {
  const text = typeof turn === 'string'
    ? turn
    : JSON.stringify(turn ?? '');
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimateTrajectoryTokens(turns) {
  if (!Array.isArray(turns)) return 0;
  return turns.reduce((sum, turn) => sum + estimateTurnTokens(turn), 0);
}

function protectIndices(turns, opts = {}) {
  const head = Math.max(1, opts.protectHead ?? 2);
  const tail = Math.max(1, opts.protectTail ?? 3);
  const protectedSet = new Set();

  for (let i = 0; i < Math.min(head, turns.length); i += 1) protectedSet.add(i);
  for (let i = Math.max(0, turns.length - tail); i < turns.length; i += 1) protectedSet.add(i);

  return protectedSet;
}

function summarizeMiddleTurns(middleTurns, opts = {}) {
  if (middleTurns.length === 0) return buildStructuredSummaryTemplate();

  const roles = middleTurns.map((turn) => turn?.role || turn?.type || 'unknown');
  const snippets = middleTurns.slice(0, 8).map((turn, idx) => {
    const role = roles[idx];
    const content = typeof turn?.content === 'string'
      ? turn.content.slice(0, 240)
      : JSON.stringify(turn?.content ?? '').slice(0, 240);
    return `- [${role}] ${content}`;
  });

  return buildStructuredSummaryTemplate({
    '## Active Task': opts.activeTask || 'Resume from protected tail turns.',
    '## Resolved': snippets.slice(0, 3).join('\n'),
    '## Pending': snippets.slice(3, 5).join('\n') || '(none)',
    '## Remaining Work': `Compressed ${middleTurns.length} middle turns.`,
    '## Key Artifacts': opts.artifacts || '(see tail turns)',
  });
}

function compactTrajectory(turns, opts = {}) {
  const input = Array.isArray(turns) ? turns : [];
  const targetTokens = opts.targetMaxTokens ?? DEFAULT_TARGET_TOKENS;
  const beforeTokens = estimateTrajectoryTokens(input);

  if (beforeTokens <= targetTokens || input.length <= 4) {
    return {
      turns: input,
      beforeTokens,
      afterTokens: beforeTokens,
      compressed: false,
      removedTurns: 0,
      summaryTurn: null,
    };
  }

  const headCount = Math.min(Math.max(1, opts.protectHead ?? 2), input.length);
  const tailCount = Math.min(Math.max(1, opts.protectTail ?? 3), Math.max(0, input.length - headCount));
  const head = input.slice(0, headCount);
  const tail = input.slice(input.length - tailCount);
  const middle = input.slice(headCount, input.length - tailCount);

  if (middle.length === 0) {
    return {
      turns: input,
      beforeTokens,
      afterTokens: beforeTokens,
      compressed: false,
      removedTurns: 0,
      summaryTurn: null,
    };
  }

  const summaryText = summarizeMiddleTurns(middle, opts);
  const summaryTurn = {
    role: 'system',
    type: 'compaction_summary',
    content: summaryText,
    meta: {
      source: 'hermes-trajectory-compactor',
      removedTurns: middle.length,
      summaryBudgetTokens: computeSummaryTokenBudget(beforeTokens - estimateTrajectoryTokens([...head, ...tail])),
    },
  };

  const compacted = [...head, summaryTurn, ...tail];
  const afterTokens = estimateTrajectoryTokens(compacted);

  return {
    turns: compacted,
    beforeTokens,
    afterTokens,
    compressed: true,
    removedTurns: middle.length,
    summaryTurn,
  };
}

function sampleTrajectory(turns, percent = 15) {
  const input = Array.isArray(turns) ? turns : [];
  const pct = Math.max(1, Math.min(100, Number(percent) || 15));
  const keep = Math.max(1, Math.ceil((input.length * pct) / 100));
  return input.slice(0, keep);
}

module.exports = {
  DEFAULT_TARGET_TOKENS,
  estimateTurnTokens,
  estimateTrajectoryTokens,
  protectIndices,
  compactTrajectory,
  sampleTrajectory,
};
