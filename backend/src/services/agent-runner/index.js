'use strict';

/**
 * AgentRunner — generic Claude-style orchestrator for chat.
 *
 * Triggers on:
 *   - attached files
 *   - prior conversation artifacts (follow-ups)
 *   - create-a-document requests ("crea una ppt … de color rosado")
 *
 * Cycle: LLM → tool_call → tool_result → LLM (max 25), native OpenRouter
 * function calling with ReAct fallback. Model-agnostic via `model` / env.
 */

const fs = require('fs');
const path = require('path');
const { createSandbox } = require('../doc-agent/sandbox');
const { isValidOoxml, createOpenRouterClient, DEFAULT_MODEL, resolveMaxRuntimeMs } = require('../doc-agent');
const { composeAbortSignals, throwIfAborted } = require('../../utils/abort-signals');
const { buildAgentRunnerPrompt } = require('./prompt');
const { TOOL_DEFINITIONS, makeToolExecutors } = require('./tools');
const { runAgentLoop, MAX_ITERATIONS_DEFAULT, isLlmCreditError } = require('./loop');
const {
  resolveTurnFiles,
  persistOutputs,
  hasConversationArtifacts,
} = require('./artifacts');
const {
  isAsyncEnabled,
  enqueueAgentRunnerJob,
  waitForAgentRunnerJob,
} = require('./queue');

const MAX_OUTPUT_RETRIES = 3;

// office_helpers.py is loaded LAZY and FAIL-OPEN. An eager readFileSync at
// module top used to throw ENOENT in production builds that did not copy the
// .py file — requiring agent-runner crashed, and /doc/generate silently fell
// back to the dark document pipeline. Without helpers the agent still works
// (it writes its own zipfile code); with them it is just faster.
let officeHelpersPyCache;
function loadOfficeHelpersPy({ dir } = {}) {
  const fromDefaultDir = !dir;
  if (fromDefaultDir && officeHelpersPyCache !== undefined) return officeHelpersPyCache;
  let text = null;
  try {
    text = fs.readFileSync(path.join(dir || __dirname, 'office_helpers.py'), 'utf8');
  } catch (_) {
    text = null;
  }
  if (fromDefaultDir) officeHelpersPyCache = text;
  return text;
}

const CREATE_DOC_RE = /\b(crea|creame|créame|genera|hazme|hazme|arma|diseña|designa|make|create)\b/i;
const DOC_NOUN_RE = /\b(ppt|pptx|ppts|powerpoint|presentaci[oó]n|diapositiva|slides?|word|docx|documento|excel|xlsx|pdf)\b/i;


const { NAMED_COLORS } = require('./tools');

function inferColorFromText(text) {
  const t = String(text || '');
  const hex = t.match(/#([0-9a-fA-F]{6})/);
  if (hex) return hex[1].toUpperCase();
  const keys = Object.keys(NAMED_COLORS).sort((a, b) => b.length - a.length);
  for (const name of keys) {
    if (new RegExp('\\b' + name + '\\b', 'i').test(t)) return NAMED_COLORS[name];
  }
  return null;
}

const STYLE_EDIT_RE = /\b(ponlas?|p[ií]ntalas?|colorea|uniformisa|uniformiza|c[aá]mbialas|cambia(?:rles)?|fondo|hex)\b/i;
// Any named color from the shared palette (naranja, turquesa, dorado, …),
// the word "color", or a #hex — kept in sync with tools.NAMED_COLORS so a
// style follow-up in ANY color routes into the runner.
const COLOR_WORD_RE = new RegExp(
  `\\b(color|${Object.keys(NAMED_COLORS).join('|')})\\b|#[0-9a-fA-F]{6}`,
  'i',
);
const WORK_RE = /\b(crea|creame|créame|genera|hazme|arma|diseña|make|create|edita|modifica|cambia|ponlas|p[ií]ntalas|uniformi[sz]a|agrega|añade|anade|corrige|arregla|fondo|hex|gracias|thanks|inserta|reemplaza|borra|elimina)\b/i;

function shouldRunAgentRunner({
  files = [],
  fileIds = [],
  hasPriorArtifacts = false,
  text = '',
} = {}) {
  const hasFiles = (Array.isArray(files) && files.length > 0)
    || (Array.isArray(fileIds) && fileIds.length > 0);
  const t = String(text || '');
  if (isRunnerOnlyDocumentTurn(t)) return true;
  const work = WORK_RE.test(t);
  if ((hasFiles || hasPriorArtifacts) && work) return true;
  return false;
}

/**
 * The claim triggers whose ONLY correct fulfilment is an AgentRunner file:
 * create-a-document requests ("crea una ppt del embarazo celeste") and
 * style/color follow-ups ("ponlas todas rosadas"). When the runner fails on
 * one of these, the chat must show an honest error — falling through to the
 * LLM loop / generic document pipeline produced the 8-slide template decks.
 * (Edit turns claimed via attached files + a work verb are NOT runner-only:
 * the surgical document_edit path may still legitimately handle them.)
 */
function isRunnerOnlyDocumentTurn(text) {
  const t = String(text || '');
  if (CREATE_DOC_RE.test(t) && DOC_NOUN_RE.test(t)) return true;
  // Follow-ups like "ponlas todas de color rosado" with no new upload.
  if (STYLE_EDIT_RE.test(t) && COLOR_WORD_RE.test(t)) return true;
  return false;
}

function defaultModel() {
  return process.env.SIRAGPT_AGENT_RUNNER_MODEL
    || process.env.SIRAGPT_DOC_AGENT_MODEL
    || process.env.OPENROUTER_MODEL
    || DEFAULT_MODEL;
}

/** Refuse to call OpenRouter with CI dummy keys (tests fall through). */
function canCallLlm({ client } = {}) {
  if (client) return true;
  const key = String(process.env.OPENROUTER_API_KEY || '').trim();
  if (!key) return false;
  if (/dummy|not-used|ci-dummy|test-key/i.test(key)) return false;
  return true;
}

function sanitizeUploadName(name, index) {
  const base = String(name || `file-${index + 1}`).split(/[\\/]/).pop();
  const clean = base.replace(/[^\w.\-() À-ɏ]/g, '_').slice(0, 180);
  return clean || `file-${index + 1}`;
}

async function collectValidOutputs(sandbox, onEvent = () => {}) {
  const outputs = await sandbox.collectOutputs();
  for (const out of outputs) {
    const ext = String(out.name).split('.').pop().toLowerCase();
    if (!out.buffer || out.buffer.length === 0) {
      out.valid = false;
      onEvent({ type: 'output_invalid', name: out.name, reason: 'empty_file' });
    } else if (['docx', 'xlsx', 'pptx'].includes(ext)) {
      out.valid = isValidOoxml(out.buffer);
      if (!out.valid) onEvent({ type: 'output_invalid', name: out.name, reason: 'ooxml_structure' });
    } else {
      out.valid = true;
    }
  }
  outputs.sort((a, b) => Number(b.valid !== false) - Number(a.valid !== false));
  return outputs;
}

async function runAgentRunner({
  files = [],
  instruction,
  model,
  client,
  onEvent = () => {},
  driver,
  maxIterations = MAX_ITERATIONS_DEFAULT,
  signal,
  chatId = null,
  userId = null,
  persist = persistOutputs,
} = {}) {
  const task = String(instruction || '').trim();
  if (!task) throw new Error('runAgentRunner: instruction is required');
  let llm = client || null;
  const resolvedModel = model || defaultModel();

  const abortScope = composeAbortSignals([signal], {
    timeoutMs: resolveMaxRuntimeMs(process.env.SIRAGPT_AGENT_RUNNER_MAX_RUNTIME_MS),
    timeoutReason: 'agent_runner_timeout',
  });
  let sandbox = null;
  try {
    throwIfAborted(abortScope.signal);
    sandbox = await createSandbox({
      driver,
      signal: abortScope.signal,
      persistKey: chatId || null,
    });
    onEvent({
      type: 'sandbox_ready',
      driver: sandbox.driver,
      persistent: Boolean(sandbox.persistent),
      label: 'Preparando entorno',
    });

    const names = [];
    const priorNames = [];
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i];
      if (!f || !Buffer.isBuffer(f.buffer)) continue;
      const name = sanitizeUploadName(f.name, i);
      await sandbox.putFile(`uploads/${name}`, f.buffer);
      names.push(name);
      if (f.isPriorArtifact) priorNames.push(name);
    }
    await sandbox.exec('mkdir -p /workspace/outputs /workspace/previews /workspace/tmp /workspace/uploads', { timeoutMs: 10_000 });
    const officeHelpersPy = loadOfficeHelpersPy();
    if (officeHelpersPy) {
      try { await sandbox.writeFile('tmp/office_helpers.py', officeHelpersPy); } catch (_) { /* agent writes its own code */ }
    }

    const system = buildAgentRunnerPrompt({ fileNames: names, priorArtifactNames: priorNames });
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: task },
    ];

    const executors = makeToolExecutors(sandbox);

    // Deterministic fast-paths are allowed ONLY for exact edits on an
    // EXISTING pptx (paint a color, append a thanks slide). Creating a NEW
    // deck must ALWAYS go through the LLM loop so the slide copy answers the
    // user's actual topic — a "crea una ppt + color" stub with filler bullets
    // is exactly the quality failure Phase 1 removes.
    const color = inferColorFromText(task);
    const pptxUpload = names.find((n) => /\.pptx$/i.test(n));
    const isCreateRequest = CREATE_DOC_RE.test(task) && DOC_NOUN_RE.test(task);
    let fastPathUsed = false;
    if (color && pptxUpload && !isCreateRequest) {
      onEvent({ type: 'tool_call', tool: 'set_slide_background', label: 'Ejecutando código', preview: color });
      const painted = await executors.set_slide_background({ path: `uploads/${pptxUpload}`, color: `#${color}` });
      onEvent({
        type: 'tool_result',
        tool: 'set_slide_background',
        ok: !String(painted).startsWith('ERROR:'),
        preview: painted,
        label: 'Verificando resultado',
      });
      fastPathUsed = !String(painted).startsWith('ERROR:');
    } else if (
      pptxUpload
      && /\b(gracias|thanks)\b/i.test(task)
      && /\b(l[aá]mina|diapositiva|slide|ppt|agrega|a[nñ]ade|pon)\b/i.test(task)
    ) {
      onEvent({ type: 'tool_call', tool: 'execute_python', label: 'Ejecutando código', preview: 'append_text_slide Gracias' });
      try {
        const { appendTextSlide } = require('./office-helpers');
        const srcBuf = await sandbox.readFile(`uploads/${pptxUpload}`);
        const added = appendTextSlide({ buffer: srcBuf, title: 'Gracias' });
        await sandbox.writeFile('outputs/deck-gracias.pptx', added.buffer);
        onEvent({
          type: 'tool_result',
          tool: 'execute_python',
          ok: true,
          preview: JSON.stringify({ ok: true, path: '/workspace/outputs/deck-gracias.pptx', slide: added.slideNumber }),
          label: 'Verificando resultado',
        });
        fastPathUsed = true;
      } catch (err) {
        onEvent({
          type: 'tool_result',
          tool: 'execute_python',
          ok: false,
          preview: err?.message || String(err),
          label: 'Reintentando',
        });
      }
    }

    let outputs = await collectValidOutputs(sandbox, onEvent);
    if (fastPathUsed && outputs.filter((o) => o.valid !== false).length > 0) {
      const previewTarget = outputs.find((o) => o.valid !== false);
      onEvent({ type: 'tool_call', tool: 'render_preview', label: 'Verificando resultado', preview: previewTarget.name });
      const preview = await executors.render_preview({ path: `outputs/${previewTarget.name}` });
      onEvent({
        type: 'tool_result',
        tool: 'render_preview',
        ok: !String(preview).startsWith('ERROR:'),
        preview,
        label: 'Verificando resultado',
      });
      const namesOut = outputs.map((o) => o.name).join(', ');
      const summary = color
        ? `Listo. Generé ${namesOut} con el color pedido (#${color}).`
        : `Listo. Generé ${namesOut}.`;
      onEvent({ type: 'outputs', count: outputs.length, names: outputs.map((o) => o.name), label: 'Listo' });
      return {
        finalText: summary,
        outputs,
        driver: sandbox.driver,
        model: resolvedModel,
        iterations: 0,
        steps: [],
        stoppedReason: 'fast_path',
      };
    }

    if (!llm) llm = createOpenRouterClient();

    let result = await runAgentLoop({
      client: llm,
      model: resolvedModel,
      messages,
      tools: TOOL_DEFINITIONS,
      executors,
      maxIterations,
      onEvent,
      signal: abortScope.signal,
    });
    throwIfAborted(abortScope.signal);
    outputs = await collectValidOutputs(sandbox, onEvent);

    let outputAttempt = 1;
    while (
      !abortScope.signal.aborted
      // Out of credits (OpenRouter/Anthropic 402): another loop pass costs
      // latency and cannot succeed — stop retrying and surface the reason.
      && result.stoppedReason !== 'llm_402'
      && outputs.filter((o) => o.valid !== false).length === 0
      && outputAttempt < MAX_OUTPUT_RETRIES
    ) {
      outputAttempt += 1;
      onEvent({
        type: 'retry',
        reason: 'no_valid_output',
        attempt: outputAttempt,
        label: 'Reintentando',
      });
      messages.push({
        role: 'user',
        content:
          `You have NOT produced a valid deliverable in /workspace/outputs (attempt ${outputAttempt}/${MAX_OUTPUT_RETRIES}). `
          + 'Use execute_python (python-pptx / python-docx / openpyxl / zipfile / tmp/office_helpers.py) to CREATE or EDIT the file, '
          + 'save it under /workspace/outputs/, then call render_preview and inspect the result. Do this now. '
          + 'If this is the last attempt and it still fails, report the error honestly.',
      });
      result = await runAgentLoop({
        client: llm,
        model: resolvedModel,
        messages,
        tools: TOOL_DEFINITIONS,
        executors,
        maxIterations: Math.min(maxIterations, 8),
        onEvent,
        signal: abortScope.signal,
      });
      throwIfAborted(abortScope.signal);
      outputs = await collectValidOutputs(sandbox, onEvent);
    }

    onEvent({ type: 'outputs', count: outputs.length, names: outputs.map((o) => o.name), label: 'Listo' });
    return { ...result, outputs, driver: sandbox.driver, model: resolvedModel };
  } finally {
    try { if (sandbox) await sandbox.destroy(); } finally { abortScope.cleanup(); }
  }
}

/**
 * Chat entry: load prior artifacts, run the loop, persist outputs as
 * download cards. Used by agentic-chat-stream as the generic preloop.
 */
async function runAgentRunnerForChat({
  prisma,
  userId,
  chatId,
  fileIds = [],
  attachedFiles = [],
  instruction,
  model,
  client,
  signal,
  onEvent = () => {},
  driver,
  maxIterations,
} = {}) {
  let loaded = attachedFiles;
  if ((!loaded || !loaded.length) && prisma && userId && Array.isArray(fileIds) && fileIds.length) {
    loaded = await loadFilesByIds({ prisma, userId, fileIds });
  }
  const resolved = await resolveTurnFiles({
    prisma,
    userId,
    chatId,
    attachedFiles: loaded,
  });
  const run = await runAgentRunner({
    files: resolved.files,
    instruction,
    model,
    client,
    onEvent,
    driver,
    maxIterations,
    signal,
    chatId,
    userId,
  });
  const valid = (run.outputs || []).filter((o) => o && o.valid !== false && o.buffer && o.buffer.length);
  const artifacts = await persistOutputs({
    outputs: valid,
    userId,
    chatId,
    prisma,
    onEvent,
  });
  const summary = String(run.finalText || '').trim()
    || (artifacts.length
      ? `Listo. Generé ${artifacts.map((a) => a.filename).join(', ')}.`
      : 'No pude generar el archivo. Intenta de nuevo con más detalle.');
  // A loop that "finished" without a deliverable is a no_output failure for
  // the caller — 'final'/'fast_path' only describe HOW the loop stopped.
  let failReason = run.stoppedReason || 'no_output';
  if (failReason === 'final' || failReason === 'fast_path') failReason = 'no_output';
  return {
    ok: artifacts.length > 0,
    summary,
    artifacts,
    steps: run.steps || [],
    iterations: run.iterations,
    driver: run.driver,
    stoppedReason: artifacts.length ? 'agent_runner' : failReason,
    errorMessage: artifacts.length ? null : (run.errorMessage || null),
    priorArtifactId: resolved.latest?.id || null,
  };
}

/**
 * Honest Spanish failure copy per skip/fail reason. Shown to the user when
 * the runner claimed the turn but could not deliver a verified file —
 * NEVER replaced by the generic 8-slide pipeline template.
 */
const AGENT_RUNNER_FAILURE_COPY = {
  no_llm: 'no hay un modelo de IA disponible para el agente (falta configurar o habilitar la clave del proveedor)',
  llm_402: 'el proveedor de IA rechazó la petición por falta de créditos (HTTP 402); recarga créditos del modelo y vuelve a intentarlo',
  no_output: 'el agente terminó sin producir un archivo verificado',
  verification_failed: 'el agente no pudo verificar que el archivo quedara correcto',
  max_iterations: 'el agente agotó sus pasos sin producir un archivo verificado',
  exception: 'el agente falló con un error inesperado',
};

function buildAgentRunnerFailureMessage(reason, detail) {
  const key = String(reason || 'no_output');
  const why = AGENT_RUNNER_FAILURE_COPY[key] || `el agente no pudo completar la tarea (${key})`;
  const extra = detail ? ` Detalle técnico: ${String(detail).slice(0, 300)}` : '';
  return `No pude generar el documento: ${why}. `
    + 'Para no entregarte contenido de relleno, NO voy a usar la plantilla genérica en su lugar. '
    + `Corrige la causa e inténtalo de nuevo.${extra ? `\n\n${extra.trim()}` : ''}`;
}

/**
 * Chat/queue entry that prefers a BullMQ job + Redis SSE fan-out and
 * falls back to the in-process loop when Redis is down or we are in tests.
 */
async function executeAgentRunnerTurn(params = {}) {
  const instruction = String(params.instruction || '');
  // Without an LLM only the PAINT fast-path can deliver: a color plus a style
  // edit ("ponlas rosadas") or an attached/prior pptx to repaint. Creating a
  // NEW deck always requires the LLM (content must match the topic), so a
  // create-doc request with a dummy key is honestly skipped, never stubbed.
  const hasTurnFiles = (Array.isArray(params.fileIds) && params.fileIds.length > 0)
    || (Array.isArray(params.attachedFiles) && params.attachedFiles.length > 0);
  const colorFastPath = Boolean(inferColorFromText(instruction))
    && (STYLE_EDIT_RE.test(instruction) || hasTurnFiles);
  if (!colorFastPath && !canCallLlm(params) && !params.client) {
    return {
      ok: false,
      skipped: true,
      summary: '',
      artifacts: [],
      steps: [],
      stoppedReason: 'no_llm',
    };
  }
  if (isAsyncEnabled() && !params.forceSync && !params.client) {
    try {
      const { createRedisConnection } = require('../agents/agent-task-queue');
      const connection = params.redis || createRedisConnection({
        label: 'agent-runner-pub',
        enableOfflineQueue: false,
      });
      const { jobId } = await enqueueAgentRunnerJob({
        instruction: params.instruction,
        userId: params.userId,
        chatId: params.chatId,
        fileIds: params.fileIds,
        model: params.model,
      }, { connection: params.queueConnection || connection });
      onEventSafe(params.onEvent, { type: 'stage', label: 'Agente trabajando', tool: 'agent_runner', jobId });
      return await waitForAgentRunnerJob({
        jobId,
        connection,
        onEvent: params.onEvent,
        signal: params.signal,
      });
    } catch (err) {
      try { console.warn('[agent-runner] async path failed, in-process:', err && err.message); } catch (_) { /* ignore */ }
    }
  }
  try {
    return await runAgentRunnerForChat(params);
  } catch (err) {
    // User cancellation is not a runner failure — let the caller unwind.
    if (params.signal?.aborted) throw err;
    // Never throw for real failures: the routes need the reason to show an
    // honest error instead of silently falling back to the generic pipeline.
    const reason = isLlmCreditError(err) ? 'llm_402' : 'exception';
    try { console.warn('[agent-runner] turn failed:', reason, err && err.message); } catch (_) { /* ignore */ }
    return {
      ok: false,
      skipped: false,
      summary: '',
      artifacts: [],
      steps: [],
      stoppedReason: reason,
      errorMessage: err?.message || String(err),
    };
  }
}

function onEventSafe(onEvent, ev) {
  try { if (typeof onEvent === 'function') onEvent(ev); } catch (_) { /* ignore */ }
}

/**
 * /api/doc/generate entry — AgentRunner FIRST, pipeline ONLY when the runner
 * does not claim the request.
 *
 * Returns:
 *   - `null` when the request is NOT an AgentRunner turn (the caller then
 *     falls through to the source-preserving editor and the pipeline);
 *   - `{ content, file, format, artifacts }` when the runner delivered a
 *     verified file (exact shape the doc route streams to the client);
 *   - `{ agentRunnerClaimed: true, failed: true, reason, message }` when the
 *     runner claimed the turn but could not deliver. The caller MUST surface
 *     `message` as an honest error and MUST NOT fall back to the generic
 *     8-slide pipeline template — that silent fallback is exactly the
 *     production failure this shape removes.
 */
async function runAgentRunnerForDocRoute({
  prisma,
  userId,
  chatId = null,
  prompt,
  fileIds = [],
  model,
  client,
  signal,
  driver,
  maxIterations,
  onStage = () => {},
} = {}) {
  const text = String(prompt || '').trim();
  if (!text) return null;
  let prior = false;
  if (prisma && userId && chatId) {
    try {
      prior = await hasConversationArtifacts(prisma, { userId, chatId });
    } catch (_) { prior = false; }
  }
  if (!shouldRunAgentRunner({ fileIds, hasPriorArtifacts: prior, text })) return null;
  const ran = await executeAgentRunnerTurn({
    prisma,
    userId,
    chatId,
    fileIds,
    instruction: text,
    model,
    client,
    signal,
    driver,
    maxIterations,
    onEvent: (ev) => {
      if (!ev) return;
      if (ev.label || ev.type === 'tool_call' || ev.type === 'tool_result' || ev.type === 'retry') {
        onEventSafe(onStage, {
          label: ev.label
            || (ev.type === 'tool_call' ? 'Ejecutando código' : 'Verificando resultado'),
          tool: ev.tool || 'agent_runner',
        });
      }
    },
  });
  const failure = (reason, detail) => ({
    agentRunnerClaimed: true,
    failed: true,
    reason: String(reason || 'no_output'),
    message: buildAgentRunnerFailureMessage(reason, detail),
  });
  if (!ran || !ran.ok || !Array.isArray(ran.artifacts) || !ran.artifacts.length) {
    return failure(ran?.stoppedReason || 'no_output', ran?.errorMessage || null);
  }
  const artifact = ran.artifacts.find((a) => a && a.downloadUrl) || ran.artifacts[0];
  if (!artifact || !artifact.downloadUrl) {
    return failure('no_output', 'artifact sin downloadUrl');
  }
  return {
    content: ran.summary,
    format: artifact.format,
    file: {
      type: 'doc',
      format: artifact.format,
      title: artifact.filename,
      explanation: 'Generado y verificado por el agente.',
      filename: artifact.filename,
      url: artifact.downloadUrl,
      dataUrl: null,
      mime: artifact.mime,
      size: artifact.sizeBytes,
    },
    artifacts: ran.artifacts,
  };
}

async function loadFilesByIds({ prisma, userId, fileIds }) {
  if (!prisma?.file || !userId) return [];
  const ids = fileIds.map(String).filter(Boolean);
  if (!ids.length) return [];
  const rows = await prisma.file.findMany({
    where: { id: { in: ids }, userId: String(userId) },
  });
  const out = [];
  const { readSourceBuffer } = require('../source-preserving-document-edit');
  const objectStorage = require('../object-storage');
  const fs = require('fs/promises');
  for (const row of rows) {
    try {
      let buffer;
      if (row.path && objectStorage.isRemote && objectStorage.isRemote(row.path)) {
        const read = await readSourceBuffer(row);
        buffer = read.buffer;
        await read.cleanup().catch(() => {});
      } else if (row.path) {
        buffer = await fs.readFile(row.path);
      }
      if (Buffer.isBuffer(buffer) && buffer.length) {
        out.push({ name: row.originalName || row.filename, buffer, fileId: row.id });
      }
    } catch (_) { /* skip unreadable */ }
  }
  return out;
}

const { logDocumentRouting, DOCUMENT_ROUTING_PATHS } = require('./telemetry');

module.exports = {
  shouldRunAgentRunner,
  isRunnerOnlyDocumentTurn,
  logDocumentRouting,
  DOCUMENT_ROUTING_PATHS,
  runAgentRunner,
  runAgentRunnerForChat,
  runAgentRunnerForDocRoute,
  executeAgentRunnerTurn,
  buildAgentRunnerFailureMessage,
  canCallLlm,
  defaultModel,
  loadOfficeHelpersPy,
  MAX_ITERATIONS_DEFAULT,
  MAX_OUTPUT_RETRIES,
  CREATE_DOC_RE,
  DOC_NOUN_RE,
  STYLE_EDIT_RE,
  hasConversationArtifacts,
};
