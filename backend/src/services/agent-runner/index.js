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
const { runAgentLoop, MAX_ITERATIONS_DEFAULT } = require('./loop');
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
const OFFICE_HELPERS_PY = fs.readFileSync(
  path.join(__dirname, 'office_helpers.py'),
  'utf8',
);

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

function inferTopic(text) {
  return String(text || '')
    .replace(CREATE_DOC_RE, ' ')
    .replace(DOC_NOUN_RE, ' ')
    .replace(/\b(color|de|del|la|el|las|los|una|un|todas?|todos?)\b/gi, ' ')
    .replace(/#[0-9a-fA-F]{6}/g, ' ')
    .replace(/\b(blanco|blanca|rosado|rosada|rosa|azul|negro|roja?|verde|gris)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'Presentación';
}


const STYLE_EDIT_RE = /\b(ponlas|p[ií]ntalas|uniformisa|uniformiza|c[aá]mbialas|cambia(?:rles)?|fondo|hex)\b/i;
const COLOR_WORD_RE = /\b(color|rosad[oa]s?|rosa|blanc[oa]s?|azul(?:es)?|negr[oa]s?|verde(?:s)?|gris(?:es)?|#([0-9a-fA-F]{6}))\b/i;
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
  if (CREATE_DOC_RE.test(t) && DOC_NOUN_RE.test(t)) return true;
  // Follow-ups like "ponlas todas de color rosado" with no new upload.
  if (STYLE_EDIT_RE.test(t) && COLOR_WORD_RE.test(t)) return true;
  const work = WORK_RE.test(t);
  if ((hasFiles || hasPriorArtifacts) && work) return true;
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
    await sandbox.writeFile('tmp/office_helpers.py', OFFICE_HELPERS_PY);

    const system = buildAgentRunnerPrompt({ fileNames: names, priorArtifactNames: priorNames });
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: task },
    ];

    const executors = makeToolExecutors(sandbox);

    // Deterministic high-level color path (optional tool, not a hardcoded
    // intent router). The generic loop still handles thanks-slides, commas,
    // rewrites, and anything the shortcut cannot prove.
    const color = inferColorFromText(task);
    const pptxUpload = names.find((n) => /\.pptx$/i.test(n));
    let fastPathUsed = false;
    if (color && pptxUpload) {
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
    } else if (color && CREATE_DOC_RE.test(task) && DOC_NOUN_RE.test(task)) {
      const topic = inferTopic(task);
      onEvent({ type: 'tool_call', tool: 'create_presentation', label: 'Ejecutando código', preview: topic });
      const created = await executors.create_presentation({
        topic,
        title: topic,
        color: `#${color}`,
        slides: 8,
      });
      onEvent({
        type: 'tool_result',
        tool: 'create_presentation',
        ok: !String(created).startsWith('ERROR:'),
        preview: created,
        label: 'Verificando resultado',
      });
      fastPathUsed = !String(created).startsWith('ERROR:');
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
  return {
    ok: artifacts.length > 0,
    summary,
    artifacts,
    steps: run.steps || [],
    iterations: run.iterations,
    driver: run.driver,
    stoppedReason: artifacts.length ? 'agent_runner' : (run.stoppedReason || 'no_output'),
    priorArtifactId: resolved.latest?.id || null,
  };
}

/**
 * Chat/queue entry that prefers a BullMQ job + Redis SSE fan-out and
 * falls back to the in-process loop when Redis is down or we are in tests.
 */
async function executeAgentRunnerTurn(params = {}) {
  const instruction = String(params.instruction || '');
  const colorFastPath = Boolean(inferColorFromText(instruction))
    && (CREATE_DOC_RE.test(instruction) || STYLE_EDIT_RE.test(instruction) || DOC_NOUN_RE.test(instruction));
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
  return runAgentRunnerForChat(params);
}

function onEventSafe(onEvent, ev) {
  try { if (typeof onEvent === 'function') onEvent(ev); } catch (_) { /* ignore */ }
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

module.exports = {
  shouldRunAgentRunner,
  runAgentRunner,
  runAgentRunnerForChat,
  executeAgentRunnerTurn,
  canCallLlm,
  defaultModel,
  MAX_ITERATIONS_DEFAULT,
  MAX_OUTPUT_RETRIES,
  CREATE_DOC_RE,
  DOC_NOUN_RE,
  hasConversationArtifacts,
};
