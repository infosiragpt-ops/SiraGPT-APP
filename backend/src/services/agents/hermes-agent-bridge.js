'use strict';

/**
 * Hermes agent bridge — JS port of hermes-agent/agent/* orchestration.
 * Wraps SiraGPT agent-entry + context compaction without Python.
 */

const { compactContext } = require('../sira/context-compactor');
const { pruneToolResults, buildStructuredSummaryTemplate } = require('./hermes-context-patterns');

async function runTurn(opts = {}) {
  const { runAgent } = require('./agent-entry');
  const userId = opts.userId;
  const prompt = String(opts.prompt || '').trim();
  if (!userId) throw new Error('runTurn: userId required');
  if (!prompt) throw new Error('runTurn: prompt required');

  return runAgent({
    userId,
    prompt,
    thinking: opts.thinking || 'low',
    model: opts.model || 'gpt-4o',
    maxSteps: opts.maxSteps || 8,
    toolset: opts.toolset || null,
    source: opts.source || 'hermes:agent-bridge',
    depth: opts.depth || 0,
    taskId: opts.taskId || null,
  });
}

async function compressConversation(opts = {}) {
  const messages = Array.isArray(opts.messages) ? opts.messages : [];
  const pruned = pruneToolResults(messages, { keepTailToolResults: opts.keepTailToolResults ?? 2 });
  const report = await compactContext({
    messages: pruned.messages,
    model: opts.model || null,
    ragChunks: opts.ragChunks || [],
    memoryGists: opts.memoryGists || [],
    summarizer: opts.summarizer || null,
  });

  if (!report.summary && report.stats?.dropped_messages > 0) {
    report.summary = buildStructuredSummaryTemplate({
      '## Active Task': opts.activeTask || 'Continue from the latest user message.',
      '## Remaining Work': `${report.stats.dropped_messages} middle turns were compacted.`,
    });
  }

  return {
    ...report,
    prunedToolResults: pruned.pruned,
  };
}

function getAgentCapabilities() {
  const toolsetRegistry = require('./toolset-registry');
  const { buildHermesTools } = require('./hermes-tools');
  return {
    entrypoints: ['agent-entry.runAgent', 'hermes-agent-bridge.runTurn'],
    toolsets: toolsetRegistry.listToolsets().map((t) => t.id),
    hermesTools: buildHermesTools().map((t) => t.name),
    maxSpawnDepth: require('./agent-entry').MAX_SPAWN_DEPTH,
  };
}

module.exports = {
  runTurn,
  compressConversation,
  getAgentCapabilities,
};
