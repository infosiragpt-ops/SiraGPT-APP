'use strict';

/**
 * Hermes agent bridge — JS port of hermes-agent/agent/* orchestration.
 * Wraps SiraGPT agent-entry + context compaction without Python.
 */

const crypto = require('crypto');
const { compactContext } = require('../sira/context-compactor');
const { pruneToolResults, buildStructuredSummaryTemplate } = require('./hermes-context-patterns');
const nativeLlm = require('../agent-runner/native-llm');
const {
  buildProviderChatPayload,
  isDeepSeekV4ModelId,
} = require('../ai-product-os/litellm-gateway');

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function resolveHermesModel(raw) {
  const key = String(raw ?? '').trim().toLowerCase();
  const aliases = {
    '': 'deepseek-v4-flash',
    'sira rápido': 'deepseek-v4-flash',
    'sira rapido': 'deepseek-v4-flash',
    'sira-rapido': 'deepseek-v4-flash',
    'sira pro': 'deepseek-v4-pro',
    'sira-pro': 'deepseek-v4-pro',
  };
  const model = Object.hasOwn(aliases, key) ? aliases[key] : key;
  if (!isDeepSeekV4ModelId(model)) {
    throw fail('E_PARAMS', 'Elige Sira Rápido o Sira Pro para ejecutar el agente.');
  }
  return model;
}

/** A private native client for this run; request bodies cannot inject clients or URLs. */
function createHermesLlmRuntime(opts = {}) {
  const model = resolveHermesModel(opts.model);
  if (opts.provider != null && String(opts.provider).trim().toLowerCase() !== 'deepseek') {
    throw fail('E_PARAMS', 'La conexión seleccionada no está permitida para este agente.');
  }
  let endpoint;
  try {
    endpoint = new URL(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com');
  } catch (_) {
    throw fail('E_PROVIDER', 'La conexión del agente no está disponible.');
  }
  if (endpoint.origin !== 'https://api.deepseek.com'
      || !['', '/', '/v1', '/v1/'].includes(endpoint.pathname)
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw fail('E_PROVIDER', 'La conexión del agente no está disponible.');
  }

  const nativeClient = nativeLlm.resolveAgentLlmClient();
  if (!nativeClient) throw fail('E_PROVIDER', 'La conexión del agente no está disponible.');
  const create = async (params = {}, requestOptions = {}) => {
    const callOptions = { ...requestOptions, signal: requestOptions.signal || opts.signal || undefined };
    // Also enforce the selected segment at every planner / executor call.
    // An internal default must fail visibly instead of downgrading Pro.
    const { model: requestedModel, messages, tools, tool_choice: toolChoice,
      stream, max_tokens: maxOutputTokens, ...extra } = params;
    if (requestedModel !== model) {
      throw fail('E_PARAMS', 'La ejecución intentó cambiar el modelo seleccionado.');
    }
    const { payload } = buildProviderChatPayload({
      provider: 'deepseek', model, messages, tools, toolChoice,
      stream, maxOutputTokens, thinkingLevel: opts.thinking || 'low', extra,
    });
    try {
      return await nativeLlm.callModelWithRetry(
        () => nativeClient.chat.completions.create(payload, callOptions),
        { signal: callOptions.signal },
      );
    } catch (_) {
      if (callOptions.signal?.aborted) throw fail('E_CANCELLED', 'La ejecución del agente fue cancelada.');
      throw fail('E_PROVIDER', 'El modelo seleccionado no pudo completar la solicitud. Reintenta.');
    }
  };
  return { model, provider: 'deepseek', client: { chat: { completions: { create } } } };
}

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

  const runtime = createHermesLlmRuntime(opts);
  const result = await runAgent({
    userId,
    prompt,
    thinking: opts.thinking || 'low',
    model: runtime.model,
    plannerModel: runtime.model,
    provider: runtime.provider,
    openai: runtime.client,
    maxSteps: opts.maxSteps || 8,
    maxRuntimeMs: opts.maxRuntimeMs,
    toolset: opts.toolset || null,
    source: opts.source || 'hermes:agent-bridge',
    depth: opts.depth || 0,
    taskId: opts.taskId || null,
    signal: opts.signal || null,
  });

  if (opts.signal?.aborted || ['aborted', 'cancelled'].includes(result.stoppedReason)) {
    throw fail('E_CANCELLED', 'La ejecución del agente fue cancelada.');
  }
  const modelFailed = (reason) => /^(model_error|synthesis_error)(:|$)/.test(String(reason || ''))
    || reason === 'error: El modelo seleccionado no pudo completar la solicitud. Reintenta.';
  if (modelFailed(result.stoppedReason)
      || (Array.isArray(result.steps) && result.steps.some((step) => modelFailed(step?.stoppedReason)))) {
    throw fail('E_PROVIDER', 'El modelo seleccionado no pudo completar la solicitud. Reintenta.');
  }

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
  resolveHermesModel,
  compressConversation,
  getAgentCapabilities,
  maybeRunLearningLoop,
};
