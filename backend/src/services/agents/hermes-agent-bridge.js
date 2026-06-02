'use strict';

/**
 * Hermes agent bridge — JS port of hermes-agent/agent/* orchestration.
 * Wraps SiraGPT agent-entry + context compaction without Python.
 */

const crypto = require('crypto');
const { compactContext } = require('../sira/context-compactor');
const { pruneToolResults, buildStructuredSummaryTemplate } = require('./hermes-context-patterns');

function extractToolName(step) {
  if (!step || typeof step !== 'object') return null;
  if (typeof step.toolCall === 'string') return step.toolCall;
  if (step.toolCall?.name) return step.toolCall.name;
  if (typeof step.tool === 'string') return step.tool;
  if (step.tool?.name) return step.tool.name;
  if (step.name && (step.type === 'tool' || step.result !== undefined)) return step.name;
  return null;
}

function normalizeSkillSlug(text) {
  const slug = String(text || 'workflow')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'workflow';
}

function buildSkillCandidate({ prompt, result, tools, toolCallCount }) {
  const promptText = String(prompt || '').replace(/\s+/g, ' ').trim();
  const digest = crypto.createHash('sha256').update(promptText).digest('hex').slice(0, 12);
  const base = promptText.split(/[.!?\n]/)[0].slice(0, 80) || 'flujo agentic';
  return {
    title: `Workflow reutilizable: ${base}`,
    slug: `auto-${normalizeSkillSlug(base)}-${digest}`,
    reason: 'complex_tool_run',
    tools,
    toolCallCount,
    stoppedReason: result?.stoppedReason || 'unknown',
    promptDigest: digest,
    suggestedSections: [
      'Cuándo usarlo',
      'Pasos verificables',
      'Herramientas necesarias',
      'Fallos comunes y recuperación',
      'Criterios de verificación',
    ],
  };
}

function maybeRunLearningLoop({ userId, prompt, result, opts = {} }) {
  if (opts.learning === false) return null;
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  const toolCalls = steps.map(extractToolName).filter(Boolean);
  const tools = [...new Set(toolCalls)];
  const complex = opts.learning === true || steps.length >= 5 || toolCalls.length >= 3 || tools.length >= 3;

  if (!complex) {
    return opts.learning === true
      ? { triggered: false, reason: 'run_not_complex', stepCount: steps.length, toolCallCount: toolCalls.length, tools }
      : null;
  }

  const report = {
    triggered: true,
    reason: 'complex_tool_run',
    stepCount: steps.length,
    toolCallCount: toolCalls.length,
    tools,
    memoryPromotion: null,
    skillCandidate: buildSkillCandidate({ prompt, result, tools, toolCallCount: toolCalls.length }),
  };

  try {
    const memoryBridge = require('./hermes-memory-bridge');
    report.memoryPromotion = memoryBridge.nudgePromotion(userId);
    if (opts.persistLearning !== false) {
      const entry = memoryBridge.remember(
        userId,
        `Candidato de skill detectado: ${report.skillCandidate.title} (herramientas: ${tools.join(', ') || 'ninguna'})`,
        { category: 'skill_candidate', tags: ['hermes', 'learning-loop', 'skill-candidate'], confidence: 0.6 },
      );
      report.memoryEntryId = entry?.id || null;
    }
  } catch (err) {
    report.memoryPromotion = { promoted: 0, error: err?.message || String(err) };
  }

  return report;
}

async function runTurn(opts = {}) {
  const { runAgent } = require('./agent-entry');
  const userId = opts.userId;
  const prompt = String(opts.prompt || '').trim();
  if (!userId) throw new Error('runTurn: userId required');
  if (!prompt) throw new Error('runTurn: prompt required');

  const result = await runAgent({
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

  const learning = maybeRunLearningLoop({ userId, prompt, result, opts });
  return learning ? { ...result, learning } : result;
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
    learningLoop: {
      complexStepThreshold: 5,
      complexToolCallThreshold: 3,
      emitsSkillCandidates: true,
      promotesMemory: true,
    },
  };
}

module.exports = {
  runTurn,
  compressConversation,
  getAgentCapabilities,
  maybeRunLearningLoop,
};
