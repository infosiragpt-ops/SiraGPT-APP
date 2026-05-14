const OpenAI = require('openai');
const reactAgent = require('../react-agent');
const { buildTaskTools } = require('./task-tools');
const taskStore = require('./task-store');
const auditLog = require('./audit-log');
const metrics = require('./metrics');
const {
  buildExecutionProfile,
  validateFinalize,
} = require('./agentic-execution-profile');
const { buildUserIntentAlignmentProfile } = require('./user-intent-alignment');
const { buildAgentTaskPlan } = require('./agent-task-plan');
const { resolveTaskContract } = require('./task-contract-resolver');
const { listManifests } = require('./tool-manifest');
const {
  buildUniversalTaskContract,
  deriveLegacyTaskContract,
  enforceLegacyTaskContract,
} = require('./universal-task-contract');
const {
  buildEnterpriseExecutionGraph,
  buildEnterpriseRuntimeProfile,
} = require('./enterprise-agentic-runtime');
const { buildToolRuntimePlan } = require('./enterprise-tool-gateway');
const { buildAgenticQaBoardReview } = require('./agentic-qa-board');
const { buildAgenticOperatingCore } = require('./agentic-operating-core');
const durableExecutionStore = require('./durable-execution-store');
const { buildDocumentDeliveryPolicy } = require('./document-delivery-policy');
const { getQueueName } = require('./agent-task-queue');
const persistence = require('./agent-task-persistence');
const { generateAutoDocument } = require('./auto-document-delivery');
const {
  generateVancouverMatrixDocument,
  isVancouverMatrixWordRequest,
} = require('./vancouver-table-document');
const { buildLangGraphLayer } = require('./agentic-langgraph');
const { buildAgenticFrameworkStatus } = require('./agentic-frameworks');
const {
  buildTranscriptionTextFromFiles,
  buildUploadedFileContext,
  isPlainTranscriptionRequest,
  resolveTranscriptionFileIds,
  serializeMessageAttachments,
} = require('../message-attachments');
const {
  assessAttachmentContext,
  countUsefulWords,
  stripScaffolding,
} = require('./attachment-context-guard');

const prisma = (() => {
  try { return require('../../config/database'); } catch { return null; }
})();

function routeInternals() {
  return require('../../routes/agent-task').INTERNAL;
}

function buildFinalizeProfile(executionProfile, universalTaskContract) {
  // Dynamic approved tool list from the manifest — no hardcoded names.
  // This stays current as new tools are registered without code changes.
  const appTools = new Set(listManifests().map((m) => m.name));
  const executableContractTools = new Set(
    (universalTaskContract?.required_tools || [])
      .filter((tool) => tool !== 'finalize')
      .filter((tool) => appTools.has(tool))
  );
  return {
    ...(executionProfile || {}),
    requiredTools: Array.from(new Set([
      ...(executionProfile?.requiredTools || []),
      ...executableContractTools,
    ])),
    minimumToolCalls: {
      ...(executionProfile?.minimumToolCalls || {}),
      ...(universalTaskContract?.source_requirements?.verification_policy === 'strict' && executableContractTools.has('web_search')
        ? { web_search: Math.max(2, executionProfile?.minimumToolCalls?.web_search || 0) }
        : {}),
    },
  };
}

function summarizeForChat(text, policy) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  const intro = `Preparé el entregable profesional en formato ${String(policy?.format || 'documento').toUpperCase()} y lo validé antes de adjuntarlo.`;
  if (!raw) return intro;
  let clipped;
  if (raw.length <= 900) {
    clipped = raw;
  } else {
    // Surrogate-safe slice: pull the cut back if the last kept code
    // unit is a high surrogate so we don't emit a dangling surrogate
    // that JSON.stringify would replace with U+FFFD.
    let cut = 900;
    const code = raw.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    clipped = `${raw.slice(0, cut).trim()}...`;
  }
  return `${intro}\n\nResumen conversacional:\n\n${clipped}`;
}

function normalizeAttachmentFallbackContent(text) {
  const tableHeaderCells = new Set([
    'n', 'no', 'titulo', 'titulo del articulo', 'autores', 'ano de publicacion',
    'enfoque y o tipo de estudio', 'muestreo', 'procedencia', 'ocupacion',
    'instrumento', 'modelo teorico', 'resultados',
  ]);
  const cells = String(text || '')
    .replace(/\*{1,3}/g, '')
    .replace(/\|/g, '\n')
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^[-:]{2,}$/.test(line))
    .filter((line) => !/^\d{1,3}$/.test(line))
    .filter((line) => {
      const key = line
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
      return !tableHeaderCells.has(key);
    });
  return cells.join('. ');
}

function normalizedKey(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function splitReadableSentences(text) {
  const seen = new Set();
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?;:])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 35)
    .filter((sentence) => {
      const key = normalizedKey(sentence);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 36);
}

function scoreAttachmentSentence(sentence, request = '') {
  const normalized = normalizedKey(sentence);
  let score = 0;
  if (/\b(se encontro|se evidencio|se identifico|se observo|muestra|indica|concluye|recomienda|sugiere|resultado|resultados|hallazgo|hallazgos|asocia|asociacion|relacion significativa|incrementa|reduce|mejora)\b/.test(normalized)) score += 5;
  if (/\b(ansiedad|depresion|estres|riesgo|impacto|efecto|efectos|salud mental|rendimiento|adiccion|vulnerabilidad|malestar)\b/.test(normalized)) score += 2;
  if (sentence.length >= 80 && sentence.length <= 420) score += 1;
  if (/\b(cuantitativo|cualitativo|transversal|probabilistico|conveniencia|cuestionario|escala|inventario|modelo teorico|autores|publicacion)\b/.test(normalized)) score -= 2;

  const requestTerms = Array.from(new Set(normalizedKey(request).match(/[a-z0-9]{5,}/g) || []))
    .filter((term) => !['resumen', 'resume', 'documento', 'archivo', 'adjunto', 'quiero', 'dame', 'necesito', 'analisis'].includes(term));
  for (const term of requestTerms) {
    if (normalized.includes(term)) score += 1;
  }
  return score;
}

function selectAttachmentSentences(sentences, request = '', limit = 8) {
  const ranked = sentences.map((sentence, index) => ({ sentence, index, score: scoreAttachmentSentence(sentence, request) }));
  const strong = ranked
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.sentence);
  return strong.length ? strong : sentences.slice(0, limit);
}

function looksLikeMissingAttachmentAnswer(text) {
  const value = String(text || '').toLowerCase();
  if (!value.trim()) return true;
  return (
    value.includes('no hay contenido disponible') ||
    value.includes('no se encontró texto disponible') ||
    value.includes('no se encontro texto disponible') ||
    value.includes('proporciona un archivo legible') ||
    value.includes('no pude acceder al contenido')
  );
}

function looksLikeEmptyOrWeakFinalAnswer(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return true;
  return (
    value === 'null' ||
    value === 'undefined' ||
    value === '(agent returned empty message)' ||
    value === 'respuesta vacía' ||
    value === 'respuesta vacia'
  );
}

function sanitizeAttachmentFallbackReason(reason) {
  const value = String(reason || '').toLowerCase();
  if (!value) return '';
  if (/quota|billing|payment|rate.?limit|too many requests|429/.test(value)) {
    return 'el proveedor principal alcanzó un límite temporal';
  }
  if (/api[_ -]?key|authentication|unauthorized|forbidden|not configured|no est[aá] configurado/.test(value)) {
    return 'el runtime principal no estuvo disponible';
  }
  if (/timeout|timed out|etimedout|socket|econn|network|dns|enotfound|eai_again/.test(value)) {
    return 'el runtime principal tardó demasiado en responder';
  }
  return 'el runtime principal no completó la solicitud';
}

function wantsSingleParagraphAnswer(request) {
  const value = normalizedKey(request);
  return (
    /\b(?:un|uno|1)\s+(?:solo\s+)?parrafo\b/.test(value) ||
    /\ben\s+(?:un|uno|1)\s+parrafo\b/.test(value) ||
    /\bparrafo\s+unico\b/.test(value)
  );
}

/**
 * Only emit bullet lists when the user explicitly asked for them.
 * Spanish triggers: "bullets", "viñetas", "vinetas", "lista", "puntos
 * clave", "key points", "checklist". Prose is the default — matches
 * the user-facing directive "análisis de documentos sin viñetas".
 */
function wantsBulletList(request) {
  const value = normalizedKey(request);
  return (
    /\bvinetas?\b/.test(value) ||
    /\bbullets?\b/.test(value) ||
    /\blistas?\b/.test(value) ||
    /\bpuntos?\s+(?:clave|principales)\b/.test(value) ||
    /\bchecklist\b/.test(value) ||
    /\benumera(?:r|cion)?\b/.test(value)
  );
}

function buildAttachmentGroundedFallbackAnswer({ goal, uploadedFileContext, reason = '' }) {
  const cleanedRaw = stripScaffolding(uploadedFileContext);
  const cleaned = normalizeAttachmentFallbackContent(cleanedRaw)
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || countUsefulWords(cleaned) < 30) return '';

  const request = String(goal || '');
  const requestedParagraphs = Math.max(
    1,
    Math.min(6, Number((request.match(/\b(\d{1,2})\s+p[aá]rrafos?\b/i) || [])[1]) || 0)
  );
  const wantsConclusions = /\b(conclusi[oó]n|conclusiones|concluye|concluir)\b/i.test(request);
  const wantsSummary = /\b(resumen|resume|sintesis|s[ií]ntesis|de qu[eé] trata|qu[eé] dice|explica)\b/i.test(request);
  const wantsRecommendations = /\b(recomendaci[oó]n|recomendaciones|sugerencia|sugerencias|propuesta|propuestas)\b/i.test(request);
  const paragraphCount = requestedParagraphs || (wantsConclusions ? 3 : 2);
  const sentences = splitReadableSentences(cleaned);
  if (sentences.length === 0) {
    return cleaned.slice(0, 1600);
  }

  const publicReason = sanitizeAttachmentFallbackReason(reason);
  const note = publicReason
    ? `\n\n> Nota operativa: respondí con el análisis documental local porque ${publicReason}. Así el chat nunca queda sin respuesta cuando el runtime principal falla.`
    : '';

  const bulletSentences = selectAttachmentSentences(sentences, request, 8)
    .map((sentence) => sentence.replace(/^[,;:\s]+/, '').replace(/\.{2,}/g, '.').trim())
    .filter(Boolean);

  // Bullets are now opt-in. Default to prose; only emit list markers
  // when the user explicitly asks for "viñetas / lista / puntos clave".
  const allowBullets = wantsBulletList(request);
  const executiveSummary = allowBullets
    ? bulletSentences
        .slice(0, Math.max(3, Math.min(5, bulletSentences.length)))
        .map((sentence) => `- ${sentence.length > 360 ? `${sentence.slice(0, 360).trim()}...` : sentence}`)
        .join('\n')
    : bulletSentences
        .slice(0, Math.max(3, Math.min(5, bulletSentences.length)))
        .map((sentence) => sentence.length > 360 ? `${sentence.slice(0, 360).trim()}...` : sentence)
        .join(' ');

  if (wantsSingleParagraphAnswer(request)) {
    const selected = (bulletSentences.length ? bulletSentences : sentences)
      .slice(0, Math.max(3, Math.min(5, bulletSentences.length || sentences.length)));
    const paragraph = selected.join(' ').replace(/\s+/g, ' ').trim();
    const clipped = paragraph.length > 1800 ? `${paragraph.slice(0, 1800).trim()}...` : paragraph;
    const inlineNote = publicReason
      ? ` Respondí con análisis documental local porque ${publicReason}.`
      : '';
    return `${clipped}${inlineNote}`;
  }

  if (!wantsConclusions) {
    const body = sentences.slice(0, Math.max(4, paragraphCount * 2)).join(' ');
    const clippedBody = body.length > 1800 ? `${body.slice(0, 1800).trim()}...` : body;
    if (wantsSummary || wantsRecommendations) {
      // When the user didn't ask for bullets we render the executive
      // summary as a normal paragraph (`Resumen ejecutivo: prose…`).
      // Recommendations also become a final prose sentence, not a
      // list, so the whole answer stays bullet-free unless the user
      // opts in via wantsBulletList.
      const heading = '### Análisis del documento adjunto';
      const summaryBlock = executiveSummary
        ? allowBullets
          ? `**Resumen ejecutivo**\n${executiveSummary}`
          : `**Resumen ejecutivo.** ${executiveSummary}`
        : clippedBody;
      const recommendationsBlock = wantsRecommendations
        ? allowBullets
          ? '\n**Siguiente paso recomendado**\n- Usar estos hallazgos como base y pedirme una matriz, informe Word/PDF o tabla comparativa si necesitas entregable descargable.'
          : '\n**Siguiente paso recomendado.** Usa estos hallazgos como base y pídeme una matriz, informe Word/PDF o tabla comparativa si necesitas un entregable descargable.'
        : '';
      return [heading, '', summaryBlock, recommendationsBlock, note].filter(Boolean).join('\n');
    }
    return `${clippedBody}${note}`;
  }

  const connectors = [
    'En primer lugar,',
    'Asimismo,',
    'Finalmente,',
    'De forma complementaria,',
    'Como cierre,',
    'En sintesis,',
  ];
  const perParagraph = Math.max(1, Math.ceil(Math.min(sentences.length, paragraphCount * 3) / paragraphCount));
  const paragraphs = [];
  for (let index = 0; index < paragraphCount; index += 1) {
    const group = sentences.slice(index * perParagraph, (index + 1) * perParagraph);
    if (group.length === 0) break;
    paragraphs.push(`${connectors[index] || 'Ademas,'} ${group.join(' ')}`);
  }
  const evidenceBlock = executiveSummary
    ? allowBullets
      ? `\n**Evidencia base usada**\n${executiveSummary}`
      : `\n**Evidencia base usada.** ${executiveSummary}`
    : '';
  return [
    '### Conclusiones basadas en el documento adjunto',
    '',
    paragraphs.join('\n\n'),
    evidenceBlock,
    note,
  ].filter(Boolean).join('\n');
}

function buildAttachmentUnavailableFallbackAnswer({ reason = '' } = {}) {
  const publicReason = sanitizeAttachmentFallbackReason(reason);
  return [
    'Recibí el archivo adjunto, pero todavía no tengo texto legible suficiente para responder con precisión.',
    '',
    '**Para resolverlo rápido:**',
    '- Si es un PDF escaneado o una imagen, sube una versión más nítida o con OCR.',
    '- Si es Word/Excel/PDF con texto, vuelve a subir el archivo original.',
    '- También puedes pegar aquí el fragmento clave y lo analizo de inmediato.',
    publicReason
      ? `\n> Nota operativa: activé una respuesta segura porque ${publicReason}; preferí pedir material legible antes que inventar contenido.`
      : '',
  ].filter(Boolean).join('\n');
}

// Map a user-selected model id to the provider whose OpenAI-compatible
// chat/completions API can serve the agent runtime. The agent runner is
// built against the OpenAI Node SDK shape, but DeepSeek, OpenRouter and
// Gemini's OpenAI-compat surface all speak the same protocol, so we
// don't have to force-remap every selection to `gpt-4o-mini`.
function detectAgentRuntimeProvider(modelId) {
  const id = String(modelId || '').trim();
  if (!id) return null;
  if (/^(gpt-|o\d|chatgpt-|ft:gpt-|ft:o)/i.test(id)) {
    return { provider: 'OpenAI', apiKeyEnv: 'OPENAI_API_KEY', baseURL: null };
  }
  if (/^deepseek(-|\/|$)/i.test(id)) {
    return { provider: 'DeepSeek', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com' };
  }
  if (/^gemini-/i.test(id) || /^imagen-/i.test(id)) {
    return {
      provider: 'Gemini',
      apiKeyEnv: 'GEMINI_API_KEY',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    };
  }
  if (/^(anthropic|meta-llama|moonshotai|x-ai|openrouter)\//i.test(id)) {
    return {
      provider: 'OpenRouter',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': process.env.NEXT_PUBLIC_URL || process.env.FRONTEND_URL || 'http://localhost:3000',
        'X-Title': 'SiraGPT',
      },
    };
  }
  return null;
}

function buildOpenAICompatibleClient(target) {
  if (!target || !target.apiKeyEnv) return null;
  const apiKey = process.env[target.apiKeyEnv];
  if (!apiKey) return null;
  const opts = { apiKey };
  if (target.baseURL) opts.baseURL = target.baseURL;
  if (target.defaultHeaders) opts.defaultHeaders = target.defaultHeaders;
  return new OpenAI(opts);
}

function normalizeAgentRuntimeModel(selectedModel) {
  const displayModel = String(selectedModel || '').trim() || 'gpt-4o';
  const configuredFallback = String(
    process.env.AGENT_TASK_OPENAI_MODEL ||
    process.env.AGENT_TASK_RUNTIME_MODEL ||
    'gpt-4o-mini'
  ).trim();
  const detected = detectAgentRuntimeProvider(displayModel);
  const isOpenAINative = detected && detected.provider === 'OpenAI';
  return {
    displayModel,
    runtimeModel: detected ? displayModel : configuredFallback,
    runtimeProvider: isOpenAINative
      ? 'selected-openai'
      : detected
        ? `selected-${detected.provider.toLowerCase()}`
        : 'openai-fallback',
    detected,
    remapped: !detected,
  };
}

// Resolve the OpenAI-compatible client the agent runtime should drive.
// Tries the user's selected provider first; if that provider has no API
// key configured, walks a small fallback list so we never hand the
// runtime null on a host that has at least one key set.
function resolveAgentRuntimeClient(profile) {
  const tried = new Set();
  const tryTarget = (target) => {
    if (!target) return null;
    const key = `${target.provider}:${target.apiKeyEnv}`;
    if (tried.has(key)) return null;
    tried.add(key);
    return buildOpenAICompatibleClient(target);
  };

  let primary = tryTarget(profile?.detected);
  if (primary) {
    return { client: primary, model: profile.runtimeModel, provider: profile.detected.provider };
  }

  const fallbackTargets = [
    { provider: 'OpenAI', apiKeyEnv: 'OPENAI_API_KEY', baseURL: null, model: profile?.runtimeModel || 'gpt-4o-mini' },
    { provider: 'DeepSeek', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
    {
      provider: 'OpenRouter',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': process.env.NEXT_PUBLIC_URL || process.env.FRONTEND_URL || 'http://localhost:3000',
        'X-Title': 'SiraGPT',
      },
      model: 'moonshotai/kimi-k2.6',
    },
  ];
  for (const target of fallbackTargets) {
    const client = tryTarget(target);
    if (client) {
      return { client, model: target.model, provider: target.provider };
    }
  }
  return { client: null, model: profile?.runtimeModel || 'gpt-4o-mini', provider: 'unconfigured' };
}

async function persistAssistantMessage({
  chatId,
  userId,
  assistantMessageId,
  streamState,
  task,
  status,
  artifacts,
  metadata,
}) {
  if (!chatId || !prisma) return null;
  try {
    const { serializeAgentState } = routeInternals();
    const serialized = serializeAgentState(streamState);
    const data = {
      content: serialized,
      tokens: Math.ceil(serialized.length / 4),
      metadata: {
        source: 'agent-task',
        taskId: task.taskId,
        status,
        displayGoal: task.displayGoal,
        artifacts,
        updatedAt: new Date().toISOString(),
        ...metadata,
      },
    };
    if (assistantMessageId) {
      return prisma.message.update({ where: { id: assistantMessageId }, data });
    }
    const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
    if (!chat) return null;
    return prisma.message.create({
      data: { chatId, role: 'ASSISTANT', timestamp: new Date(), ...data },
    });
  } catch {
    return null;
  }
}

async function runAgentTaskJob(payload = {}, job = null) {
  const {
    taskId,
    traceId,
    user,
    goal,
    displayGoal,
    systemContract,
    files = [],
    fileMetadata = [],
    chatId = null,
    model = 'gpt-4o',
    maxSteps = 60,
    maxRuntimeMs = 2 * 60 * 60 * 1000,
  } = payload;
  if (!taskId) throw new Error('agent task payload missing taskId');
  if (!user?.id) throw new Error('agent task payload missing user.id');
  const plainTranscriptionRequest = isPlainTranscriptionRequest(goal);
  const hasAttachedFiles = Array.isArray(files) && files.length > 0;
  const deterministicVancouverRequest = isVancouverMatrixWordRequest(`${goal || ''} ${displayGoal || ''}`) &&
    hasAttachedFiles;
  if (!process.env.OPENAI_API_KEY && !plainTranscriptionRequest && !deterministicVancouverRequest && !hasAttachedFiles) {
    throw new Error('OPENAI_API_KEY not configured');
  }

  const internals = routeInternals();
  const controller = new AbortController();
  const startedAt = Date.now();
  const existing = taskStore.getTaskSnapshotForUser(taskId, user.id);
  let streamState = existing?.streamState || internals.initialAgentState();
  let documentPolicy = payload.documentPolicy || existing?.documentPolicy || buildDocumentDeliveryPolicy({
    goal,
    displayGoal,
    files,
  });
  const runtimeModelProfile = normalizeAgentRuntimeModel(model);

  const executionProfile = buildExecutionProfile({ goal, fileIds: files });
  const intentAlignmentProfile = buildUserIntentAlignmentProfile({ request: goal, fileIds: files });
  const universalTaskContract = buildUniversalTaskContract({
    rawUserRequest: goal,
    fileIds: files,
  });
  const finalizeProfile = buildFinalizeProfile(executionProfile, universalTaskContract);
  let taskContract = deriveLegacyTaskContract(universalTaskContract);
  let taskContractSource = 'fallback';
  // Resolve the actual OpenAI-compatible client (and final model id) for
  // the user's selected provider. If the user picked DeepSeek and we have
  // DEEPSEEK_API_KEY, we drive DeepSeek directly — without this, every
  // non-OpenAI selection used to be silently remapped to gpt-4o-mini and
  // would hard-fail whenever OPENAI_API_KEY was rate-limited.
  const runtimeClientResolution = resolveAgentRuntimeClient(runtimeModelProfile);
  const openai = runtimeClientResolution.client;
  if (runtimeClientResolution.client) {
    runtimeModelProfile.runtimeModel = runtimeClientResolution.model;
    runtimeModelProfile.runtimeProvider = runtimeClientResolution.provider;
    runtimeModelProfile.remapped = runtimeClientResolution.model !== runtimeModelProfile.displayModel
      || runtimeClientResolution.provider !== runtimeModelProfile.detected?.provider;
  }
  if (!plainTranscriptionRequest && openai) {
    try {
      const resolved = await resolveTaskContract({
        goal,
        openai,
        fileIds: files,
        fallback: () => deriveLegacyTaskContract(universalTaskContract),
      });
      taskContract = enforceLegacyTaskContract(resolved.contract || taskContract, universalTaskContract);
      taskContractSource = resolved.source || taskContractSource;
    } catch (err) {
      console.warn('[agent-task-runner] task-contract resolver failed:', err?.message);
    }
  }

  const taskPlan = buildAgentTaskPlan({
    goal,
    executionProfile,
    intentAlignmentProfile,
    universalTaskContract,
    fileIds: files,
    maxRuntimeMs,
  });
  const enterpriseExecutionGraph = buildEnterpriseExecutionGraph({
    contract: universalTaskContract,
    taskId,
    userId: user.id,
    chatId,
  });
  const enterpriseToolRuntimePlan = buildToolRuntimePlan({
    contract: universalTaskContract,
    graph: enterpriseExecutionGraph,
  });
  const enterpriseQaBoardReview = buildAgenticQaBoardReview({
    contract: universalTaskContract,
    graph: enterpriseExecutionGraph,
    toolRuntimePlan: enterpriseToolRuntimePlan,
    phase: 'worker-preflight',
  });
  const agenticOperatingCore = buildAgenticOperatingCore({
    contract: universalTaskContract,
    graph: enterpriseExecutionGraph,
    toolRuntimePlan: enterpriseToolRuntimePlan,
    qaBoardReview: enterpriseQaBoardReview,
  });
  let durableExecution = null;
  try {
    durableExecution = durableExecutionStore.createDurableExecutionRecord({
      graph: enterpriseExecutionGraph,
      contract: universalTaskContract,
      taskId,
      userId: user.id,
      chatId,
      toolRuntimePlan: enterpriseToolRuntimePlan,
      qaBoardReview: enterpriseQaBoardReview,
    });
  } catch (err) {
    console.warn('[agent-task-runner] durable execution record failed:', err?.message || err);
  }
  const enterpriseRuntimeProfile = {
    ...buildEnterpriseRuntimeProfile(universalTaskContract, enterpriseExecutionGraph),
    agenticOperatingCore: agenticOperatingCore.summary,
    toolRuntime: enterpriseToolRuntimePlan.summary,
    qaPreflight: enterpriseQaBoardReview.summary,
    durableExecution: durableExecution
      ? {
        graphId: durableExecution.graphId,
        persisted: true,
        nodeCount: durableExecution.nodes.length,
        checkpointCount: durableExecution.checkpoints.length,
      }
      : { graphId: enterpriseExecutionGraph.graph_id, persisted: false },
  };

  const task = internals.createTaskRecord({
    taskId,
    userId: user.id,
    chatId,
    displayGoal,
    model,
    controller,
    maxSteps,
    maxRuntimeMs,
    streamState,
    executionProfile,
    intentAlignmentProfile,
    taskPlan,
    universalTaskContract,
    enterpriseExecutionGraph,
    enterpriseRuntimeProfile,
    enterpriseToolRuntimePlan,
    enterpriseQaBoardReview,
    agenticOperatingCore,
    durableExecution,
    jobId: job?.id ? String(job.id) : existing?.jobId || taskId,
    queueName: getQueueName(),
    traceId: traceId || existing?.traceId || null,
    documentPolicy,
    status: 'running',
  });
  task.runtimeModel = runtimeModelProfile.runtimeModel;

  const artifacts = [];
  // Throttle in-flight progress upserts. A long-running task emits
  // hundreds of events; firing a Prisma upsert + BullMQ updateProgress
  // on every single one wastes DB connections and Redis round-trips.
  // The terminal persistProgress(status) call at the end always
  // bypasses the throttle so the final state lands authoritatively.
  const PROGRESS_THROTTLE_MS = 250;
  let lastProgressAt = 0;
  const persistProgress = (status = task.status, { force = false } = {}) => {
    const now = Date.now();
    const isTerminal = status !== 'running';
    if (!force && !isTerminal && now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
    lastProgressAt = now;
    void persistence.upsertAgentTask({
      ...task,
      status,
      state: streamState,
      documentPolicy,
    });
    if (job) {
      // Catch and discard: BullMQ writes progress through Redis, which
      // can reject mid-failover. Without .catch() the rejection goes
      // unhandled and (depending on Node policy) can terminate the
      // worker. Progress is best-effort observability — never fatal.
      Promise.resolve(job.updateProgress({ status, lastEventSeq: task.lastEventSeq || 0 })).catch(() => {});
    }
  };
  const emit = (event) => {
    streamState = internals.reduceAgentState(streamState, event);
    task.streamState = streamState;
    const written = taskStore.appendTaskEvent(task, event, streamState, { eventLimit: internals.TASK_EVENT_LIMIT || 600 });
    if (written) {
      task.events = written.events || task.events;
      task.checkpoints = written.checkpoints || task.checkpoints;
      task.lastEventSeq = written.lastEventSeq || task.lastEventSeq;
      task.artifacts = written.artifacts || task.artifacts;
    }
    void persistence.appendAgentTaskEvent(task, task.events?.[task.events.length - 1] || event);
    metrics.counter('agent_task_events_total', { type: event.type || 'unknown' });
    persistProgress('running');
    return event;
  };

  emit({
    type: 'queue_status',
    taskId,
    status: 'running',
    queue: getQueueName(),
    jobId: job?.id ? String(job.id) : task.jobId,
    position: null,
    estimatedWaitMs: 0,
  });
  emit({ type: 'document_policy', policy: documentPolicy });

  const langGraphLayer = await buildLangGraphLayer({ taskId, documentPolicy });
  const tools = buildTaskTools();
  const frameworkStatus = await buildAgenticFrameworkStatus({ tools, langGraphLayer });
  emit({
    type: 'framework_status',
    taskId,
    ...frameworkStatus,
  });
  emit({
    type: 'checkpoint',
    label: langGraphLayer.enabled ? 'LangGraph durable listo' : 'Grafo durable fallback listo',
    status: 'saved',
    payload: {
      provider: langGraphLayer.provider,
      enabled: langGraphLayer.enabled,
      nodes: langGraphLayer.nodes,
      checkpointer: langGraphLayer.checkpointer || null,
      humanInTheLoop: Boolean(langGraphLayer.humanInTheLoop),
      fallback: langGraphLayer.fallback || null,
    },
  });

  emit({
    type: 'meta',
    taskId,
    goal: displayGoal,
    model,
    runtimeModel: runtimeModelProfile.runtimeModel,
    runtimeProvider: runtimeModelProfile.runtimeProvider,
    tools: tools.map((tool) => tool.name),
    executionProfile,
    intentAlignmentProfile,
    taskPlan,
    universalTaskContract,
    enterpriseExecutionGraph,
    enterpriseRuntimeProfile,
    enterpriseToolRuntimePlan,
    enterpriseQaBoardReview,
    agenticOperatingCore,
    frameworks: frameworkStatus,
    taskContract,
    taskContractSource,
  });

  auditLog.audit({
    event: 'agent_task_worker_started',
    taskId,
    userId: user.id,
    chatId,
    model,
    runtimeModel: runtimeModelProfile.runtimeModel,
    runtimeProvider: runtimeModelProfile.runtimeProvider,
    modelRemapped: runtimeModelProfile.remapped,
    queue: getQueueName(),
    jobId: job?.id ? String(job.id) : task.jobId,
    traceId: task.traceId,
    documentPolicy,
  });

  let assistantMessageId = existing?.assistantMessageId || null;
  const uploadedFileContext = await buildUploadedFileContext(prisma, {
    userId: user.id,
    fileIds: files,
    query: displayGoal || goal,
  });
  if (chatId && prisma) {
    try {
      const chat = await prisma.chat.findFirst({ where: { id: chatId, userId: user.id } });
      if (chat) {
        if (!existing?.assistantMessageId) {
          const messageFiles = await serializeMessageAttachments(prisma, {
            userId: user.id,
            fileIds: files,
            clientMetadata: fileMetadata,
          });
          await prisma.message.create({
            data: {
              chatId,
              role: 'USER',
              content: displayGoal,
              files: messageFiles.length ? messageFiles : null,
              timestamp: new Date(),
              metadata: { source: 'agent-task-user', taskId, fileIds: files },
            },
          });
        }
        const assistant = assistantMessageId
          ? null
          : await prisma.message.create({
            data: {
              chatId,
              role: 'ASSISTANT',
              content: internals.serializeAgentState(streamState),
              timestamp: new Date(),
              metadata: {
                source: 'agent-task',
                taskId,
                status: 'running',
                displayGoal,
                documentPolicy,
              },
            },
          });
        assistantMessageId = assistantMessageId || assistant?.id || null;
        task.assistantMessageId = assistantMessageId;
        taskStore.markTaskStatus(task, 'running', { assistantMessageId, streamState });
      }
    } catch {
      // DB persistence is intentionally non-fatal for local/dev.
    }
  }

  let stepIdCounter = 0;
  let currentStepId = null;
  const runtimeTimer = setTimeout(() => controller.abort(), maxRuntimeMs + 5000);
  const finishDeterministicTask = async ({
    finalMarkdown,
    stoppedReason,
    steps,
    artifactsList = artifacts,
    metadata = {},
  }) => {
    if (finalMarkdown) emit({ type: 'final_text', markdown: finalMarkdown });
    const doneEvent = emit({
      type: 'done',
      stoppedReason,
      stats: { steps, artifacts: artifactsList.length },
    });

    const status = 'completed';
    task.status = status;
    task.updatedAt = new Date().toISOString();
    const dbMessage = await persistAssistantMessage({
      chatId,
      userId: user.id,
      assistantMessageId,
      streamState,
      task,
      status,
      artifacts: artifactsList,
      metadata: {
        documentPolicy,
        runtimeModel: runtimeModelProfile.runtimeModel,
        selectedModel: model,
        executionProfile,
        intentAlignmentProfile,
        taskPlan,
        universalTaskContract,
        enterpriseExecutionGraph,
        enterpriseRuntimeProfile,
        enterpriseToolRuntimePlan,
        enterpriseQaBoardReview,
        agenticOperatingCore,
        frameworks: frameworkStatus,
        durableExecution: enterpriseRuntimeProfile.durableExecution,
        stoppedReason,
        maxSteps,
        maxRuntimeMs,
        ...metadata,
      },
    });
    if (dbMessage?.id && doneEvent) {
      emit({ type: 'checkpoint', label: 'Mensaje persistido', status: 'saved', payload: { dbMessageId: dbMessage.id } });
    }

    taskStore.markTaskStatus(task, status, {
      streamState,
      stats: {
        steps,
        artifacts: artifactsList.length,
        durationMs: Date.now() - startedAt,
        stoppedReason,
      },
      artifacts: artifactsList,
    });
    if (task.durableExecution?.graphId) {
      try {
        durableExecutionStore.markExecutionStatus(task.durableExecution.graphId, task.userId, status, {
          stats: {
            steps,
            artifacts: artifactsList.length,
            durationMs: Date.now() - startedAt,
            stoppedReason,
          },
        });
      } catch (err) {
        console.warn('[agent-task-runner] durable graph status write failed:', err.message);
      }
    }
    metrics.counter('agent_task_invocations_total', { status });
    metrics.observe('agent_task_duration_ms', { status }, Date.now() - startedAt);
    metrics.counter('agent_task_artifacts_total', { status }, artifactsList.length);
    persistProgress(status);
    auditLog.audit({
      event: 'agent_task_worker_finished',
      taskId,
      userId: user.id,
      chatId,
      status,
      stoppedReason,
      steps,
      artifacts: artifactsList.length,
      durationMs: Date.now() - startedAt,
    });
    return { taskId, status, artifacts: artifactsList.length };
  };

  try {
    if (plainTranscriptionRequest) {
      const transcriptionFileIds = Array.isArray(files) && files.length
        ? files.map(String).filter(Boolean)
        : await resolveTranscriptionFileIds(prisma, {
          userId: user.id,
          chatId,
          providedFileIds: files,
        });
      const transcriptionText = await buildTranscriptionTextFromFiles(prisma, {
        userId: user.id,
        fileIds: transcriptionFileIds,
      });

      documentPolicy = {
        ...(documentPolicy || {}),
        mode: 'chat_only',
        autoGenerate: false,
        reason: transcriptionText
          ? 'Solicitud de transcripción literal; se devuelve el texto extraído en el chat.'
          : 'Solicitud de transcripción literal sin contenido legible disponible.',
        thresholds: {
          ...(documentPolicy?.thresholds || {}),
          transcriptionOnly: true,
          fileCount: transcriptionFileIds.length,
          wordCount: transcriptionText ? transcriptionText.split(/\s+/).filter(Boolean).length : 0,
        },
      };
      task.documentPolicy = documentPolicy;
      emit({ type: 'document_policy', policy: documentPolicy });

      const readStepId = 's1';
      const finalStepId = 's2';
      stepIdCounter = 1;
      emit({ type: 'step_start', id: readStepId, label: 'Leyendo archivo adjunto', icon: 'file-text' });
      emit({ type: 'step_done', id: readStepId, ok: Boolean(transcriptionText) });
      emit({
        type: 'checkpoint',
        label: transcriptionText ? 'Texto extraído' : 'Sin texto legible',
        status: transcriptionText ? 'saved' : 'warning',
        payload: { fileIds: transcriptionFileIds, textLength: transcriptionText.length },
      });
      stepIdCounter = 2;
      emit({ type: 'step_start', id: finalStepId, label: 'Preparando transcripción', icon: 'braces' });
      emit({ type: 'step_done', id: finalStepId, ok: true });

      const finalMarkdown = transcriptionText || 'No se encontró texto disponible para transcribir en los archivos adjuntos. Por favor, proporciona un archivo legible o más detalles sobre el contenido que deseas transcribir.';
      emit({ type: 'final_text', markdown: finalMarkdown });
      const doneEvent = emit({
        type: 'done',
        stoppedReason: transcriptionText ? 'transcription_finalize' : 'no_transcription_content',
        stats: { steps: 2, artifacts: 0 },
      });

      const status = 'completed';
      task.status = status;
      task.updatedAt = new Date().toISOString();
      const dbMessage = await persistAssistantMessage({
        chatId,
        userId: user.id,
        assistantMessageId,
        streamState,
        task,
        status,
        artifacts,
        metadata: {
          documentPolicy,
          runtimeModel: runtimeModelProfile.runtimeModel,
          selectedModel: model,
          stoppedReason: transcriptionText ? 'transcription_finalize' : 'no_transcription_content',
          transcriptionFileIds,
        },
      });
      if (dbMessage?.id && doneEvent) {
        emit({ type: 'checkpoint', label: 'Mensaje persistido', status: 'saved', payload: { dbMessageId: dbMessage.id } });
      }

      taskStore.markTaskStatus(task, status, {
        streamState,
        stats: {
          steps: 2,
          artifacts: 0,
          durationMs: Date.now() - startedAt,
          stoppedReason: transcriptionText ? 'transcription_finalize' : 'no_transcription_content',
        },
        artifacts,
      });
      if (task.durableExecution?.graphId) {
        try {
          durableExecutionStore.markExecutionStatus(task.durableExecution.graphId, task.userId, status, {
            stats: {
              steps: 2,
              artifacts: 0,
              durationMs: Date.now() - startedAt,
              stoppedReason: transcriptionText ? 'transcription_finalize' : 'no_transcription_content',
            },
          });
        } catch (err) {
          console.warn('[agent-task-runner] durable graph status write failed:', err.message);
        }
      }
      metrics.counter('agent_task_invocations_total', { status });
      metrics.observe('agent_task_duration_ms', { status }, Date.now() - startedAt);
      metrics.counter('agent_task_artifacts_total', { status }, 0);
      persistProgress(status);
      auditLog.audit({
        event: 'agent_task_worker_finished',
        taskId,
        userId: user.id,
        chatId,
        status,
        stoppedReason: transcriptionText ? 'transcription_finalize' : 'no_transcription_content',
        steps: 2,
        artifacts: 0,
        durationMs: Date.now() - startedAt,
        transcriptionFileCount: transcriptionFileIds.length,
        transcriptionTextLength: transcriptionText.length,
      });
      return { taskId, status, artifacts: 0 };
    }

    // ── Thin-attachment guard ─────────────────────────────────────────
    // If the user attached files AND the question references the attachment
    // ("de qué es esto?", "qué dice este documento?"), but extraction
    // produced only a handful of useful words, refuse to bluff. Ask the
    // user for the real content instead — better UX than a confident
    // "no se pudo determinar..." follow-up wrapped in an auto DOCX.
    const attachmentStats = assessAttachmentContext({
      uploadedFileContext,
      files,
      userText: displayGoal || goal,
    });
    if (attachmentStats.isThin) {
      documentPolicy = {
        ...(documentPolicy || {}),
        mode: 'chat_only',
        autoGenerate: false,
        reason: 'Contexto adjunto insuficiente; se solicita material adicional al usuario.',
        thresholds: {
          ...(documentPolicy?.thresholds || {}),
          thinContextWords: attachmentStats.usefulWords,
          fileCount: files.length,
          transcriptionOnly: false,
        },
      };
      task.documentPolicy = documentPolicy;
      emit({ type: 'document_policy', policy: documentPolicy });

      const stepId = 's1';
      stepIdCounter = 1;
      emit({ type: 'step_start', id: stepId, label: 'Revisando adjunto', icon: 'file-text' });
      emit({ type: 'step_done', id: stepId, ok: true });
      emit({
        type: 'checkpoint',
        label: 'Adjunto con contenido insuficiente',
        status: 'warning',
        payload: { usefulWords: attachmentStats.usefulWords, fileCount: files.length },
      });

      const wordsLabel = attachmentStats.usefulWords === 1 ? '1 palabra útil' : `${attachmentStats.usefulWords} palabras útiles`;
      const finalMarkdown = [
        `El material adjunto solo contiene ${wordsLabel}, lo que no me alcanza para responder tu pregunta con confianza.`,
        '',
        '**¿Puedes ayudarme con una de estas opciones?**',
        '- Pega el texto completo de la página o documento.',
        '- Sube el archivo original (PDF, DOCX, imagen completa).',
        '- Comparte el enlace de origen para revisar el contenido directamente.',
      ].join('\n');

      emit({ type: 'final_text', markdown: finalMarkdown });
      const doneEvent = emit({
        type: 'done',
        stoppedReason: 'thin_attachment_context',
        stats: { steps: 1, artifacts: 0 },
      });

      const status = 'completed';
      task.status = status;
      task.updatedAt = new Date().toISOString();
      const dbMessage = await persistAssistantMessage({
        chatId,
        userId: user.id,
        assistantMessageId,
        streamState,
        task,
        status,
        artifacts: [],
        metadata: {
          documentPolicy,
          runtimeModel: runtimeModelProfile.runtimeModel,
          selectedModel: model,
          stoppedReason: 'thin_attachment_context',
          attachmentStats,
        },
      });
      if (dbMessage?.id && doneEvent) {
        emit({ type: 'checkpoint', label: 'Mensaje persistido', status: 'saved', payload: { dbMessageId: dbMessage.id } });
      }

      taskStore.markTaskStatus(task, status, {
        streamState,
        stats: {
          steps: 1,
          artifacts: 0,
          durationMs: Date.now() - startedAt,
          stoppedReason: 'thin_attachment_context',
        },
        artifacts: [],
      });
      if (task.durableExecution?.graphId) {
        try {
          durableExecutionStore.markExecutionStatus(task.durableExecution.graphId, task.userId, status, {
            stats: {
              steps: 1,
              artifacts: 0,
              durationMs: Date.now() - startedAt,
              stoppedReason: 'thin_attachment_context',
            },
          });
        } catch (err) {
          console.warn('[agent-task-runner] durable graph status write failed:', err.message);
        }
      }
      metrics.counter('agent_task_invocations_total', { status });
      metrics.observe('agent_task_duration_ms', { status }, Date.now() - startedAt);
      metrics.counter('agent_task_artifacts_total', { status }, 0);
      persistProgress(status);
      auditLog.audit({
        event: 'agent_task_worker_finished',
        taskId,
        userId: user.id,
        chatId,
        status,
        stoppedReason: 'thin_attachment_context',
        steps: 1,
        artifacts: 0,
        durationMs: Date.now() - startedAt,
        attachmentStats,
      });
      return { taskId, status, artifacts: 0 };
    }

    if (!openai && hasAttachedFiles) {
      const fallbackMarkdown = buildAttachmentGroundedFallbackAnswer({
        goal: displayGoal || goal,
        uploadedFileContext,
        reason: 'el proveedor principal no está configurado',
      });
      const finalFallbackMarkdown = fallbackMarkdown || buildAttachmentUnavailableFallbackAnswer({
        reason: 'el proveedor principal no está configurado',
      });
      documentPolicy = {
        ...(documentPolicy || {}),
        mode: 'chat_only',
        autoGenerate: false,
        reason: fallbackMarkdown
          ? 'Respuesta documental local generada sin proveedor LLM configurado.'
          : 'Respuesta segura por adjunto sin texto legible suficiente.',
        thresholds: {
          ...(documentPolicy?.thresholds || {}),
          attachmentFallback: true,
          usefulWords: countUsefulWords(uploadedFileContext),
          fileCount: files.length,
        },
      };
      task.documentPolicy = documentPolicy;
      emit({ type: 'document_policy', policy: documentPolicy });
      stepIdCounter = 1;
      emit({ type: 'step_start', id: 's1', label: 'Analizando documento adjunto', icon: 'file-text' });
      emit({ type: 'step_done', id: 's1', ok: Boolean(fallbackMarkdown) });
      emit({
        type: 'quality_gate',
        gate: 'attachment_local_fallback',
        label: fallbackMarkdown ? 'Respuesta documental garantizada' : 'Adjunto requiere texto legible',
        passed: Boolean(fallbackMarkdown),
        summary: fallbackMarkdown
          ? 'Se generó una respuesta desde el texto extraído del archivo sin depender del proveedor externo.'
          : 'Se devolvió una respuesta clara en vez de dejar el chat sin salida.',
      });
      return finishDeterministicTask({
        finalMarkdown: finalFallbackMarkdown,
        stoppedReason: fallbackMarkdown ? 'attachment_local_fallback' : 'attachment_unreadable_fallback',
        steps: 1,
        artifactsList: [],
        metadata: {
          attachmentFallback: true,
          fallbackReason: 'openai_not_configured',
          sourceFileIds: files,
        },
      });
    }

    if (deterministicVancouverRequest) {
      documentPolicy = {
        ...buildDocumentDeliveryPolicy({
          goal,
          displayGoal,
          files,
          requestedFormat: 'docx',
        }),
        mode: 'doc_required',
        format: 'docx',
        autoGenerate: true,
        reason: 'Solicitud explícita de tabla en Word con estructura Vancouver.',
      };
      task.documentPolicy = documentPolicy;
      emit({ type: 'document_policy', policy: documentPolicy });

      stepIdCounter = 1;
      emit({ type: 'step_start', id: 's1', label: 'Leyendo documento adjunto', icon: 'file-text' });
      emit({ type: 'step_done', id: 's1', ok: true });
      emit({
        type: 'checkpoint',
        label: 'Contenido documental disponible',
        status: 'saved',
        payload: {
          fileCount: files.length,
          contextChars: String(uploadedFileContext || '').length,
        },
      });

      stepIdCounter = 2;
      emit({ type: 'step_start', id: 's2', label: 'Construyendo matriz Vancouver', icon: 'table' });
      const generated = await generateVancouverMatrixDocument({
        prisma,
        task,
        userId: user.id,
        fileIds: files,
        goal: displayGoal || goal,
        emit,
      });
      if (generated?.artifact) artifacts.push(generated.artifact);
      emit({ type: 'step_done', id: 's2', ok: true });

      stepIdCounter = 3;
      emit({ type: 'step_start', id: 's3', label: 'Preparando entrega final', icon: 'check' });
      emit({ type: 'step_done', id: 's3', ok: true });

      return finishDeterministicTask({
        finalMarkdown: generated.finalMarkdown,
        stoppedReason: 'vancouver_matrix_docx',
        steps: 3,
        artifactsList: artifacts,
        metadata: {
          vancouverMatrix: true,
          sourceFileIds: files,
          validation: generated.validation,
        },
      });
    }

    const toolCtx = {
      userId: user.id,
      userEmail: user.email,
      openai,
      signal: controller.signal,
      chatId,
      taskId,
      fileIds: files,
      displayGoal,
      taskContract,
      universalTaskContract,
      enterpriseExecutionGraph,
      enterpriseRuntimeProfile,
      enterpriseToolRuntimePlan,
      prisma,
      onEvent: (evt) => {
        const payloadEvent = { ...evt, stepId: evt.stepId || currentStepId };
        if (evt.type === 'file_artifact' && evt.artifact) {
          artifacts.push(evt.artifact);
          void persistence.persistGeneratedArtifact({ artifact: evt.artifact, task, validation: evt.artifact.validation });
        }
        if (evt.type === 'contract_review') {
          emit({
            type: 'quality_gate',
            gate: 'contract_review',
            label: 'Contrato de artefacto',
            passed: Boolean(evt.passed),
            summary: `${evt.testsPassed || 0}/${evt.testsTotal || 0} pruebas contractuales`,
            payload: evt,
          });
        }
        emit(payloadEvent);
      },
    };

    const result = await reactAgent.run(openai, {
      query: goal,
      tools,
      maxSteps,
      maxRuntimeMs,
      model: runtimeModelProfile.runtimeModel,
      extraSystem: internals.buildAgentSystemPrompt(
        systemContract,
        files,
        executionProfile,
        intentAlignmentProfile,
        taskPlan,
        taskContract,
        universalTaskContract,
        enterpriseExecutionGraph,
        enterpriseRuntimeProfile,
        enterpriseToolRuntimePlan,
        enterpriseQaBoardReview,
        agenticOperatingCore,
        uploadedFileContext
      ),
      ctx: toolCtx,
      finalizeGuard: ({ steps }) => validateFinalize(finalizeProfile, steps),
      onStepStart: (step) => {
        stepIdCounter += 1;
        currentStepId = `s${stepIdCounter}`;
        const thought = (step.thought || '').trim();
        const firstAction = step.actions?.[0];
        const label = thought || firstAction?.tool || 'Pensando...';
        const icon = internals.inferIconFor ? internals.inferIconFor(firstAction?.tool) : undefined;
        emit({ type: 'step_start', id: currentStepId, label: internals.shortLabel ? internals.shortLabel(label) : label, icon });
      },
      onStepDone: (step) => {
        const firstAction = step.actions?.[0];
        emit({ type: 'step_done', id: currentStepId, ok: !firstAction?.observation?.error });
        emit({
          type: 'checkpoint',
          label: `Paso ${stepIdCounter} guardado`,
          status: 'saved',
          payload: { stepId: currentStepId },
        });
        currentStepId = null;
      },
    });

    let finalMarkdown = result.finalAnswer || '';
    let stoppedReason = result.stoppedReason;
    const attachmentFinalNeedsRecovery = Array.isArray(files) && files.length > 0 && (
      looksLikeEmptyOrWeakFinalAnswer(finalMarkdown) ||
      looksLikeMissingAttachmentAnswer(finalMarkdown)
    );
    if (attachmentFinalNeedsRecovery) {
      const fallbackMarkdown = buildAttachmentGroundedFallbackAnswer({
        goal: displayGoal || goal,
        uploadedFileContext,
        reason: result.stoppedReason || 'el runtime principal no entregó una respuesta final útil',
      });
      const finalFallbackMarkdown = fallbackMarkdown || buildAttachmentUnavailableFallbackAnswer({
        reason: result.stoppedReason || 'el runtime principal no entregó una respuesta final útil',
      });
      finalMarkdown = finalFallbackMarkdown;
      stoppedReason = fallbackMarkdown
        ? 'attachment_empty_response_recovery'
        : 'attachment_unreadable_empty_response_recovery';
      documentPolicy = {
        ...(documentPolicy || {}),
        mode: 'chat_only',
        autoGenerate: false,
        reason: fallbackMarkdown
          ? 'Respuesta documental local generada porque el runtime terminó sin texto final útil.'
          : 'Respuesta segura porque el runtime terminó sin texto final útil y no hubo texto legible suficiente.',
        thresholds: {
          ...(documentPolicy?.thresholds || {}),
          attachmentFallback: true,
          usefulWords: countUsefulWords(uploadedFileContext),
          fileCount: files.length,
          originalStoppedReason: result.stoppedReason,
        },
      };
      task.documentPolicy = documentPolicy;
      emit({
        type: 'repair_attempt',
        attempt: 1,
        status: fallbackMarkdown ? 'recovered' : 'degraded',
        message: fallbackMarkdown
          ? 'El runtime terminó sin una respuesta útil; se recuperó usando el texto extraído del documento.'
          : 'El runtime terminó sin una respuesta útil; se devolvió una salida clara para pedir un archivo legible.',
      });
      if (stepIdCounter === 0) {
        stepIdCounter = 1;
        currentStepId = 's1';
        emit({ type: 'step_start', id: currentStepId, label: 'Recuperando respuesta desde el documento', icon: 'file-text' });
        emit({ type: 'step_done', id: currentStepId, ok: Boolean(fallbackMarkdown) });
        currentStepId = null;
      }
      emit({
        type: 'quality_gate',
        gate: 'attachment_empty_response_recovery',
        label: fallbackMarkdown ? 'Respuesta documental recuperada' : 'Salida segura sin contenido legible',
        passed: Boolean(fallbackMarkdown),
        summary: fallbackMarkdown
          ? 'Se usó el texto extraído del adjunto para evitar una tarea completada sin respuesta.'
          : 'Se evitó una tarea completada en silencio y se explicó cómo aportar contenido legible.',
      });
    }
    documentPolicy = buildDocumentDeliveryPolicy({
      goal,
      displayGoal,
      finalText: finalMarkdown,
      files,
      requestedFormat: documentPolicy?.autoGenerate || documentPolicy?.mode === 'doc_required'
        ? documentPolicy?.format
        : null,
    });
    task.documentPolicy = documentPolicy;
    emit({ type: 'document_policy', policy: documentPolicy });

    if (documentPolicy.autoGenerate && artifacts.length === 0) {
      try {
        const generated = await generateAutoDocument({
          task,
          goal: displayGoal,
          finalText: finalMarkdown,
          policy: documentPolicy,
          signal: controller.signal,
          emit,
        });
        if (generated?.artifact) artifacts.push({
          id: generated.artifact.id,
          filename: generated.artifact.filename,
          format: generated.artifact.format,
          mime: generated.artifact.mime,
          sizeBytes: generated.artifact.sizeBytes,
          downloadUrl: generated.artifact.downloadUrl,
        });
        finalMarkdown = summarizeForChat(finalMarkdown, documentPolicy);
      } catch (err) {
        emit({
          type: 'repair_attempt',
          attempt: 1,
          status: 'failed',
          message: `La generación automática de documento falló: ${err.message}`,
        });
      }
    }

    if (finalMarkdown) emit({ type: 'final_text', markdown: finalMarkdown });
    const completedStepCount = Math.max(result.steps.length, stepIdCounter);
    const doneEvent = emit({
      type: 'done',
      stoppedReason,
      stats: { steps: completedStepCount, artifacts: artifacts.length },
    });

    const status = stoppedReason === 'aborted' ? 'cancelled' : 'completed';
    task.status = status;
    task.updatedAt = new Date().toISOString();
    const dbMessage = await persistAssistantMessage({
      chatId,
      userId: user.id,
      assistantMessageId,
      streamState,
      task,
      status,
      artifacts,
      metadata: {
        documentPolicy,
        runtimeModel: runtimeModelProfile.runtimeModel,
        selectedModel: model,
        executionProfile,
        intentAlignmentProfile,
        taskPlan,
        universalTaskContract,
        enterpriseExecutionGraph,
        enterpriseRuntimeProfile,
        enterpriseToolRuntimePlan,
        enterpriseQaBoardReview,
        agenticOperatingCore,
        frameworks: frameworkStatus,
        durableExecution: enterpriseRuntimeProfile.durableExecution,
        stoppedReason,
        maxSteps,
        maxRuntimeMs,
      },
    });
    if (dbMessage?.id && doneEvent) {
      emit({ type: 'checkpoint', label: 'Mensaje persistido', status: 'saved', payload: { dbMessageId: dbMessage.id } });
    }

    taskStore.markTaskStatus(task, status, {
      streamState,
      stats: {
        steps: completedStepCount,
        artifacts: artifacts.length,
        durationMs: Date.now() - startedAt,
        stoppedReason,
      },
      artifacts,
    });
    if (task.durableExecution?.graphId) {
      try {
        durableExecutionStore.markExecutionStatus(task.durableExecution.graphId, task.userId, status, {
          stats: {
            steps: completedStepCount,
            artifacts: artifacts.length,
            durationMs: Date.now() - startedAt,
            stoppedReason,
          },
        });
      } catch (err) {
        console.warn('[agent-task-runner] durable graph status write failed:', err.message);
      }
    }
    metrics.counter('agent_task_invocations_total', { status });
    metrics.observe('agent_task_duration_ms', { status }, Date.now() - startedAt);
    metrics.counter('agent_task_artifacts_total', { status }, artifacts.length);
    persistProgress(status);
    auditLog.audit({
      event: 'agent_task_worker_finished',
      taskId,
      userId: user.id,
      chatId,
      status,
      stoppedReason,
      steps: completedStepCount,
      artifacts: artifacts.length,
      durationMs: Date.now() - startedAt,
    });
    return { taskId, status, artifacts: artifacts.length };
  } catch (err) {
    if (!controller.signal.aborted && hasAttachedFiles) {
      const fallbackMarkdown = buildAttachmentGroundedFallbackAnswer({
        goal: displayGoal || goal,
        uploadedFileContext,
        reason: err?.message || 'el runtime principal falló',
      });
      const finalFallbackMarkdown = fallbackMarkdown || buildAttachmentUnavailableFallbackAnswer({
        reason: err?.message || 'el runtime principal falló',
      });
      documentPolicy = {
        ...(documentPolicy || {}),
        mode: 'chat_only',
        autoGenerate: false,
        reason: fallbackMarkdown
          ? 'Fallback documental local tras fallo del runtime principal.'
          : 'Respuesta segura tras fallo del runtime y adjunto sin texto legible suficiente.',
        thresholds: {
          ...(documentPolicy?.thresholds || {}),
          attachmentFallback: true,
          usefulWords: countUsefulWords(uploadedFileContext),
          fileCount: files.length,
        },
      };
      task.documentPolicy = documentPolicy;
      emit({ type: 'document_policy', policy: documentPolicy });
      emit({
        type: 'repair_attempt',
        attempt: 1,
        status: fallbackMarkdown ? 'recovered' : 'degraded',
        message: fallbackMarkdown
          ? 'El runtime principal falló; se recuperó la respuesta usando el texto extraído del documento.'
          : 'El runtime principal falló y el adjunto no aportó texto suficiente; se devolvió una salida accionable.',
      });
      if (!currentStepId) {
        stepIdCounter += 1;
        currentStepId = `s${stepIdCounter}`;
        emit({ type: 'step_start', id: currentStepId, label: 'Recuperando respuesta desde el documento', icon: 'file-text' });
      }
      emit({ type: 'step_done', id: currentStepId, ok: Boolean(fallbackMarkdown) });
      currentStepId = null;
      emit({
        type: 'quality_gate',
        gate: 'attachment_runtime_recovery',
        label: fallbackMarkdown ? 'Recuperación documental' : 'Salida segura sin contenido legible',
        passed: Boolean(fallbackMarkdown),
        summary: fallbackMarkdown
          ? 'La tarea terminó con una respuesta basada en el adjunto aunque falló el proveedor principal.'
          : 'La tarea terminó con instrucciones claras en vez de un silencio o error opaco.',
      });
      return finishDeterministicTask({
        finalMarkdown: finalFallbackMarkdown,
        stoppedReason: fallbackMarkdown ? 'attachment_runtime_recovery' : 'attachment_unreadable_recovery',
        steps: Math.max(1, stepIdCounter),
        artifactsList: [],
        metadata: {
          attachmentFallback: true,
          fallbackReason: err?.message || 'runtime_failure',
          sourceFileIds: files,
        },
      });
    }
    const message = controller.signal.aborted ? 'Tarea detenida por el usuario.' : (err.message || 'agent task failed');
    task.status = controller.signal.aborted ? 'cancelled' : 'error';
    emit({ type: 'error', message });
    taskStore.markTaskStatus(task, task.status, {
      streamState,
      stats: { durationMs: Date.now() - startedAt, error: message },
    });
    persistProgress(task.status);
    auditLog.audit({
      event: 'agent_task_worker_failed',
      taskId,
      userId: user.id,
      chatId,
      status: task.status,
      error: message,
      durationMs: Date.now() - startedAt,
    });
    if (task.status === 'error') throw err;
    return { taskId, status: task.status };
  } finally {
    clearTimeout(runtimeTimer);
  }
}

// ── Error introspection & recovery helpers ─────────────────────
// Used externally by the job scheduler to decide retry strategy.

// Add ±20% jitter so concurrent retries from the same upstream incident
// don't all hit at the exact same wall clock — flattens the recovery
// thundering herd without changing the average backoff.
function withJitter(baseMs) {
  if (!baseMs || baseMs <= 0) return baseMs;
  const spread = baseMs * 0.2;
  return Math.max(100, Math.round(baseMs + (Math.random() * 2 - 1) * spread));
}

/**
 * Classify an error thrown by runAgentTaskJob to determine retry eligibility.
 * Returns { retryable, reason, ttlMs } where ttlMs is how long before retry
 * (0 = immediate, >0 = backoff).
 */
function classifyTaskError(err) {
  if (!err) return { retryable: false, reason: 'no-error' };
  const msg = String(err.message || err).toLowerCase();
  const code = String(err.code || err.statusCode || '').toLowerCase();
  const errName = String(err.name || '').toLowerCase();

  // Non-retryable: explicit user/system abort. Retrying a cancelled job
  // would resurrect work the operator just stopped.
  if (errName === 'aborterror' || msg.includes('aborted') || msg.includes('operation was canceled') || code === 'abort_err')
    return { retryable: false, reason: 'aborted' };

  // Non-retryable: quota / billing — retry won't fix a depleted account.
  if (msg.includes('insufficient_quota') || msg.includes('insufficient quota') ||
      msg.includes('quota exceeded') || msg.includes('billing') ||
      msg.includes('payment required') || code === '402')
    return { retryable: false, reason: 'quota-exhausted' };

  // Non-retryable: token/context length — same prompt will fail again.
  if (msg.includes('context_length_exceeded') || msg.includes('context length') ||
      msg.includes('maximum context') || msg.includes('too many tokens') ||
      msg.includes('reduce the length'))
    return { retryable: false, reason: 'context-length' };

  // Non-retryable: model or content policy refusals.
  if (msg.includes('content_policy') || msg.includes('content policy') ||
      msg.includes('safety filter') || msg.includes('flagged by') ||
      msg.includes('moderation'))
    return { retryable: false, reason: 'content-policy' };

  // Non-retryable: auth / permission issues
  if (msg.includes('api_key') || msg.includes('api key') || msg.includes('authentication') || msg.includes('unauthorized') || code === '401' || code === '403')
    return { retryable: false, reason: 'auth-failure' };
  if (msg.includes('missing') && (msg.includes('taskid') || msg.includes('required')))
    return { retryable: false, reason: 'validation-error' };

  // Non-retryable: model unavailable / decommissioned / typo'd model id —
  // retrying with the same model id will fail identically. Operator must
  // update the model selection.
  if (msg.includes('model_not_found') || msg.includes('does not exist') ||
      msg.includes('deprecated model') || msg.includes('decommissioned') ||
      msg.includes('has been retired') || msg.includes('no such model'))
    return { retryable: false, reason: 'model-unavailable' };

  // Non-retryable: payload too large — same prompt/file will fail again.
  if (msg.includes('payload too large') || msg.includes('request entity too large') ||
      code === '413')
    return { retryable: false, reason: 'payload-too-large' };

  // Non-retryable: 501 Not Implemented — feature missing on upstream.
  if (code === '501' || msg.includes('not implemented'))
    return { retryable: false, reason: 'not-implemented' };

  // Retryable: rate limits (any rate / 429 / too many)
  if (code.includes('rate_limit') || msg.includes('rate limit') || msg.includes('rate_limit') || msg.includes('too many requests') || code.startsWith('429'))
    return { retryable: true, reason: 'rate-limited', ttlMs: withJitter(15_000) };

  // Retryable: DNS resolution failures — usually transient at our edge.
  if (msg.includes('enotfound') || msg.includes('eai_again') || msg.includes('getaddrinfo'))
    return { retryable: true, reason: 'dns-failure', ttlMs: withJitter(5_000) };

  // Retryable: network / timeout / connection errors. Includes 408
  // (Request Timeout) and 504 (Gateway Timeout) explicitly so they
  // don't fall into the generic 5xx bucket with a longer backoff.
  if (code.includes('timeout') || msg.includes('timeout') || msg.includes('etimedout') ||
      msg.includes('econnreset') || msg.includes('econnrefused') || msg.includes('econnaborted') ||
      msg.includes('epipe') || msg.includes('hang up') || msg.includes('socket') ||
      code === '408' || code === '504' || code.startsWith('408') || code.startsWith('504'))
    return { retryable: true, reason: 'network-timeout', ttlMs: withJitter(5_000) };

  // Retryable: TLS/SSL handshake hiccups — usually transient (clock skew,
  // intermediate proxy refresh). Cert *expired* on our side wouldn't fix
  // itself, but we still classify retryable so the operator sees the
  // pattern in retry telemetry rather than a hard fail on first call.
  if (msg.includes('cert_has_expired') || msg.includes('unable to verify') ||
      msg.includes('self signed certificate') || msg.includes('self-signed certificate') ||
      msg.includes('depth_zero_self_signed') || msg.includes('ssl handshake') ||
      msg.includes('tls handshake') || msg.includes('handshake failure'))
    return { retryable: true, reason: 'ssl-error', ttlMs: withJitter(8_000) };

  // Retryable: server errors (5xx)
  if (code.startsWith('5') || msg.includes('internal server') || msg.includes('service unavailable') || msg.includes('bad gateway'))
    return { retryable: true, reason: 'server-error', ttlMs: withJitter(10_000) };

  // Non-retryable: validation / config
  if (msg.includes('missing') || msg.includes('invalid') || msg.includes('required') || msg.includes('not configured'))
    return { retryable: false, reason: 'validation-error' };

  // Default: safe to retry once
  return { retryable: true, reason: 'unknown', ttlMs: withJitter(3_000) };
}

module.exports = {
  runAgentTaskJob,
  buildFinalizeProfile,
  classifyTaskError,
  normalizeAgentRuntimeModel,
  buildAttachmentGroundedFallbackAnswer,
};
