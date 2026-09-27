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
const { isValidOoxml, DEFAULT_MODEL, resolveMaxRuntimeMs } = require('../doc-agent');
const { parseModelSpec, resolveDocAgentCandidates, createFailoverClient } = require('../doc-agent/llm-runtime');
const { composeAbortSignals, throwIfAborted } = require('../../utils/abort-signals');
const { buildAgentRunnerPrompt } = require('./prompt');
const { TOOL_DEFINITIONS, makeToolExecutors, officeEngineEnabled } = require('./tools');
const { installOfficeEngine, ENGINE_REL: OFFICE_ENGINE_REL } = require('./tools.office');
const { createOfficeFailureReporter, verificationFailureFromSteps } = require('./turn-failure-hook');
const { agentThumbsEnabled } = require('./trace');
const { recordVerify, recordOfficeTurn } = require('./office-metrics');
const { validateSavOutput } = require('./sav-validation');
const { applySavXlsxDeliveryGate, createSavXlsxFinalEventGate } = require('./sav-xlsx-delivery');
const { needsVerification } = require('./verify');

function assessDelivery(run = {}) {
  const surgicalProof = run.stoppedReason === 'surgical_edit'
    && Array.isArray(run.outputs) && run.outputs.length > 0
    && run.outputs.every((output) => output.valid !== false && output.validation?.passed === true);
  const complete = run.stoppedReason === 'final' || run.stoppedReason === 'fast_path' || surgicalProof;
  const verificationNeeded = needsVerification(run.steps || []).needed;
  return { complete, verificationNeeded, blocked: !complete || verificationNeeded };
}

// Edición milimétrica (Fase C): the before/after image is reviewed by a
// separate vision model (multimodal/vision-ladder.js). Off under
// NODE_ENV=test and with SIRAGPT_VISUAL_VERIFY_VISION=0.
function buildVisionVerifier({ pickedModel, env = process.env, onFailover } = {}) {
  if (String(env.SIRAGPT_VISUAL_VERIFY_VISION || '').trim() === '0' || env.NODE_ENV === 'test') return null;
  try {
    const { resolveVisionCandidates, createVisionClient } = require('./multimodal/vision-ladder');
    const { makeVisionVerifier } = require('./multimodal/visual-verifier');
    const client = createVisionClient(resolveVisionCandidates({ pickedModel, env }), { onFailover });
    return client ? makeVisionVerifier({ client }) : null;
  } catch (_) {
    return null;
  }
}

// Images go INTO the loop only when explicitly enabled AND the loop model sees
// images (an image_url to a text model is a 400 with no failover).
function loopSeesImages(env = process.env) {
  if (String(env.SIRAGPT_AGENT_VISION_IN_LOOP || '').trim() !== '1') return false;
  try {
    const { resolveModelCapabilities } = require('../agent-harness/model-capabilities');
    const pinned = explicitRunnerModel(env);
    return Boolean(pinned && resolveModelCapabilities(pinned).supportsImages);
  } catch (_) {
    return false;
  }
}

// AgentRunner turns do document work (sandbox, render, changed zones, vision
// review, a correction round): the loop wall is longer than the 3H64 chat
// default of 120 s, and stays under the runner's own max runtime (10 min).
function documentTurnWallMs(env = process.env) {
  const raw = Number(env.SIRAGPT_AGENT_RUNNER_TURN_WALL_MS);
  if (Number.isFinite(raw) && raw >= 30_000) return Math.min(Math.floor(raw), 20 * 60_000);
  return 6 * 60_000;
}

const OFFICE_FILE_RE = /\.(docx|docm|dotx|xlsx|xlsm|xltx|pptx|pptm|potx)$/i;
// Document turns get room for a batch of edits (a paraphrase must not be cut
// mid-JSON, hallazgo 7). An explicit SIRAGPT_AGENT_RUNNER_MAX_TOKENS wins.
function documentTurnMaxTokens(names = [], env = process.env) {
  if (String(env.SIRAGPT_AGENT_RUNNER_MAX_TOKENS || '').trim()) return null;
  return names.some((n) => OFFICE_FILE_RE.test(String(n))) ? 8192 : null;
}

const VISION_NOTE_RE = /revisi[oó]n visual|modelo de visi[oó]n|sin visi[oó]n|no hubo revisi[oó]n/i;
/**
 * The reply must say when no vision model looked at the result (SPEC §6.1.5):
 * the automatic checks ran, a model did not see the image.
 */
function withVisionHonesty(finalText, lastVerify) {
  const text = String(finalText || '');
  if (!lastVerify || !lastVerify.passed || lastVerify.visionOk !== null) return text;
  if (VISION_NOTE_RE.test(text)) return text;
  const note = 'Verificación automática: se renderizaron las páginas, se compararon antes y después y se revisó el texto; no hubo revisión con modelo de visión.';
  return text ? `${text}\n\n${note}` : note;
}
const { runAgentLoop, MAX_ITERATIONS_DEFAULT, isLlmCreditError } = require('./loop');
const {
  resolveTurnFiles,
  persistOutputs,
  hasConversationArtifacts,
  sanitizeUploadName,
} = require('./artifacts');
const {
  isAsyncEnabled,
  enqueueAgentRunnerJob,
  waitForAgentRunnerJob,
} = require('./queue');

const MAX_OUTPUT_RETRIES = 3;
const { trySurgicalPresentationFollowup } = require('./surgical-followup');
const { isScopedSlideMutation, parsePresentationTitleEdit } = require('../document-editing/presentation-title-intent');
const { verifyContentChanged, verifySlideTitleEdit, assertBoundedOfficePackage } = require('../document-editing/edit-output-proof');
const { validateEditedPdf } = require('../doc-agent/pdf-output-validation');

/* ── F8 — memoria híbrida + skills + cliente MCP (hooks) ────────────────────
 * Los módulos viven en ./memory, ./skills y ./mcp; este helper solo ORQUESTA:
 * recall de memoria para el system prompt (como DATA, nunca instrucciones) y
 * merge de tool defs + executors extra (load_skill / mcp_list_tools /
 * mcp_call). Kill switches por módulo: SIRAGPT_AGENT_MEMORY /
 * SIRAGPT_AGENT_SKILLS / SIRAGPT_AGENT_MCP (default ON en producción, OFF
 * bajo NODE_ENV=test). Best-effort: cualquier fallo aquí degrada al runner
 * base, jamás rompe el turno.
 */
async function prepareF8Extras({
  userId = null,
  chatId = null,
  instruction = '',
  prisma = null,
  memoryStore = null,
  mcpToolLoader = null,
} = {}) {
  const out = { memoryBlock: '', toolDefinitions: [], executors: {} };
  try {
    const memory = require('./memory');
    if (userId && memory.memoryEnabled()) {
      const memories = await memory.recallForTurn({
        userId, chatId, query: instruction, store: memoryStore,
      });
      out.memoryBlock = memory.buildAgentMemoryBlock(memories);
    }
  } catch (_) { /* memory is best-effort */ }
  try {
    const skills = require('./skills');
    if (skills.skillsEnabled()) {
      out.toolDefinitions.push(...skills.extraToolDefinitions());
      Object.assign(out.executors, skills.extraExecutors());
    }
  } catch (_) { /* skills are best-effort */ }
  try {
    const mcp = require('./mcp');
    if (mcp.mcpEnabled()) {
      const toolset = await mcp.loadMcpToolset({ userId, prisma, loader: mcpToolLoader });
      out.toolDefinitions.push(...mcp.extraToolDefinitions(toolset));
      Object.assign(out.executors, mcp.extraExecutors(toolset));
    }
  } catch (_) { /* mcp is best-effort */ }
  return out;
}


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

// sira_office.py — office engine for millimetric edits with visual
// verification (docs/specs/edicion-milimetrica/SPEC.md). Installed by
// tools.office.js with the same lazy/fail-open contract as office_helpers.py:
// a missing file never breaks the runner, the agent keeps execute_python.
const SIRA_OFFICE_ENGINE_REL = OFFICE_ENGINE_REL;
const installSiraOfficeEngine = installOfficeEngine;

const CREATE_DOC_RE = /\b(crea|creame|créame|genera|hazme|hazme|arma|diseña|designa|make|create)\b/i;
const DOC_NOUN_RE = /\b(ppt|pptx|ppts|powerpoint|presentaci[oó]n|diapositiva|slides?|word|docx|documento|excel|xlsx|pdf)\b/i;
const DIRECT_SAV_FILE_REQUEST_RE = /\bdame\s+(?:un|una|el|la)\s+(?:documentos?|archivos?|ficheros?|bases?(?:\s+de\s+datos)?)\s+(?:de\s+)?(?:spss|sav)\b/i;
const SOURCE_COPY_RE = /\b(?:copia|versi[oó]n)(?:\s+(?:nueva|corregida|editada|actualizada|modificada)){0,2}\s+(?:de\s+)?(?:este|esta|mi|del|de\s+la|de\s+los|de\s+las)\b/i;


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

function previewRendered(preview) {
  const body = typeof preview === 'string' ? preview : preview?.text;
  if (typeof body !== 'string' || !body.trim() || body.startsWith('ERROR:')) return false;
  try {
    const result = JSON.parse(body);
    return result?.ok === true && result.skipped !== true
      && Array.isArray(result.frames) && result.frames.length > 0;
  } catch (_) {
    return false;
  }
}

const STYLE_EDIT_RE = /\b(ponlas?|p[ií]ntalas?|colorea|uniformisa|uniformiza|c[aá]mbialas|cambia(?:rles)?|fondo|hex)\b/i;
// Any named color from the shared palette (naranja, turquesa, dorado, …),
// the word "color", or a #hex — kept in sync with tools.NAMED_COLORS so a
// style follow-up in ANY color routes into the runner.
const COLOR_WORD_RE = new RegExp(
  `\\b(color|${Object.keys(NAMED_COLORS).join('|')})\\b|#[0-9a-fA-F]{6}`,
  'i',
);
const WORK_RE = /\b(crea|creame|créame|genera|hazme|arma|diseña|make|create|edita|modifica|cambia|pon|ponle|ponme|coloca|ponlas|p[ií]ntalas|uniformi[sz]a|agrega|añade|anade|corrige|arregla|fondo|hex|inserta|reemplaza|borra|elimina)\b/i;
// The deterministic paint fast path recolors EVERY slide background. It only
// fits «ponlas todas rosadas» / «cambia el fondo a #1E3A8A»: «Mueve la nota
// 2 mm a la derecha y ponla verde» painted all three slides green and never
// moved the note (eval pptx-nota-mover-verde). A named element or a movement
// goes to the loop, which edits that shape.
const SLIDE_BACKGROUND_RE = /\b(fondos?|background|ponlas|p[ií]ntalas|c[aá]mbialas|col[oó]realas|uniformi[sz]a\w*|todas)\b/i;
const SHAPE_TARGET_RE = /\b(notas?|cuadros?|recuadros?|t[ií]tulos?|subt[ií]tulos?|textos?|formas?|flechas?|celdas?|tablas?|im[aá]gen(?:es)?|logos?|letras?|fuentes?|bordes?|l[ií]neas?|[ií]conos?|gr[aá]ficos?|botones|bot[oó]n|palabras?|frases?|mueve|mover|mu[eé]vela|desplaza\w*)\b|\d+(?:[.,]\d+)?\s*(?:mm|cm|pt|px)\b/i;
function isSlideBackgroundColorRequest(text) {
  const t = String(text || '');
  return SLIDE_BACKGROUND_RE.test(t) && !SHAPE_TARGET_RE.test(t);
}
// Pictures are read by the vision runtime, never by the document runner: an
// attached screenshot must not turn «¿cuánto es?» into a document task.
const IMAGE_FILE_RE = /\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif|svg)$/i;
function isImageFile(file) {
  if (!file || typeof file !== 'object') return false;
  const mime = String(file.mimeType || file.type || '').toLowerCase();
  if (mime.startsWith('image/')) return true;
  return IMAGE_FILE_RE.test(String(file.name || file.originalName || file.filename || ''));
}

// «Sube a 15 … y resalta esa celda»: a formatting verb aimed at a concrete
// spot of the attached file is an edit even without a WORK_RE verb.
function isHighlightEdit(text) {
  try {
    return require('../agents/agentic-trigger').isHighlightEditRequest(text);
  } catch (_) { return false; }
}

function shouldRunAgentRunner({
  files = [],
  fileIds = [],
  hasPriorArtifacts = false,
  text = '',
} = {}) {
  const documentFiles = (Array.isArray(files) ? files : []).filter((file) => !isImageFile(file));
  const hasFiles = documentFiles.length > 0
    || (Array.isArray(fileIds) && fileIds.length > 0);
  const t = String(text || '');
  if (isRunnerOnlyDocumentTurn(t)) return true;
  const work = WORK_RE.test(t) || isHighlightEdit(t);
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
  try {
    const { isSoftwareBuildRequest, isExplicitDocumentRequest } = require('../agents/software-build-intent');
    if (isSoftwareBuildRequest(t) && !isExplicitDocumentRequest(t)) return false;
  } catch (_) { /* classifier is local */ }
  if ((CREATE_DOC_RE.test(t) && DOC_NOUN_RE.test(t)) || requestsSavExcelDelivery(t)) return true;
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

/**
 * Only the model explicitly pinned by the operator (env) is forced to the
 * front of the provider ladder; the doc-agent DEFAULT_MODEL is an OpenRouter
 * slug and must NOT pin OpenRouter first (its exhausted balance / data-policy
 * 404s killed every "crea un word/ppt" turn in production).
 */
function explicitRunnerModel(env = process.env) {
  return env.SIRAGPT_AGENT_RUNNER_MODEL || env.SIRAGPT_DOC_AGENT_MODEL || env.OPENROUTER_MODEL || null;
}

const PICKER_LADDER_PROVIDERS = new Set(['DeepSeek', 'Meta', 'Gemini', 'xAI', 'OpenAI', 'OpenRouter']);

/**
 * "Provider:model" for the model picked in the composer. Unsupported
 * providers are kept here so the runner can report their unavailability
 * instead of selecting another model.
 */
// The picker row may carry an aggregator slug («deepseek/deepseek-v4-pro»):
// a direct provider API rejects it with a 400 that never fails over («The
// supported API model names are deepseek-flash, deepseek-v4-pro, but you
// passed deepseek/deepseek-v4-pro» — every runner turn failed). OpenRouter
// keeps the slug.
const DIRECT_SLUG_PREFIX = Object.freeze({
  DeepSeek: /^deepseek\//i,
  Gemini: /^(?:google|gemini)\//i,
  xAI: /^x-?ai\//i,
  Meta: /^meta\//i,
  OpenAI: /^openai\//i,
});

function runnerModelSpec(provider, model) {
  const p = String(provider || '').trim() || 'Unresolved';
  let m = String(model || '').trim();
  if (!m) return null;
  const prefix = DIRECT_SLUG_PREFIX[p];
  if (prefix) m = m.replace(prefix, '') || m;
  return `${p}:${m}`;
}

/**
 * Keep every AgentRunner model call on the same provider and model. When the
 * composer chose a model, an unavailable API cannot silently use the ladder.
 */
const RUNNER_PROVIDER_MESSAGE = 'El modelo seleccionado no está disponible. Reintenta o elige otro modelo.';

function runnerProviderError(err) {
  const failure = new Error(RUNNER_PROVIDER_MESSAGE);
  failure.code = 'E_PROVIDER';
  const status = Number(err?.status || err?.statusCode || err?.response?.status);
  if (Number.isFinite(status) && status > 0) failure.status = status;
  return failure;
}

function resolveRunnerLlmCandidate({ pickedModel = null, env = process.env } = {}) {
  const requested = pickedModel || explicitRunnerModel(env);
  const candidates = resolveDocAgentCandidates({ model: requested || null, env });
  if (!requested) {
    if (candidates.length) return candidates[0];
    throw runnerProviderError();
  }
  const selected = parseModelSpec(requested);
  if (!selected?.provider || !PICKER_LADDER_PROVIDERS.has(selected.provider)) throw runnerProviderError();
  const candidate = candidates.find((entry) => entry.provider === selected.provider && entry.model === selected.model);
  if (!candidate) throw runnerProviderError();
  return candidate;
}

function createRunnerLlmClient({ pickedModel = null, env = process.env, createClient } = {}) {
  const selected = resolveRunnerLlmCandidate({ pickedModel, env });
  const client = createFailoverClient([selected], { createClient });
  return {
    ...client,
    chat: { completions: { create: async (...args) => {
      try {
        return await client.chat.completions.create(...args);
      } catch (err) {
        if (args[1]?.signal?.aborted || err?.name === 'AbortError' || err?.code === 'ABORT_ERR') throw err;
        throw runnerProviderError(err);
      }
    } } },
  };
}

/** A run needs at least one configured provider (CI dummy keys do not count). */
function canCallLlm({ client, pickedModel = null } = {}) {
  if (client) return true;
  try { return Boolean(resolveRunnerLlmCandidate({ pickedModel })); }
  catch (_) { return false; }
}

function resolveOutputEditSource(name, sources) {
  const basename = (value) => String(value || '').split(/[\\/]/).pop().toLowerCase();
  const outputName = basename(name);
  const exact = sources.filter((file) => basename(file.name) === outputName);
  if (exact.length === 1) return exact[0];
  const editedBase = outputName.replace(/(?:[_ -](?:editado|edited|corregido|actualizado|titulo_actualizado))+(?=\.[^.]+$)/, '');
  const named = sources.filter((file) => basename(file.name) === editedBase);
  if (named.length === 1) return named[0];
  // Duplicate names must not silently select an older reattached version.
  const relevant = exact.length ? exact : sources;
  const prior = relevant.filter((file) => file.isPriorArtifact);
  if (prior.length === 1) return prior[0];
  return relevant.length === 1 ? relevant[0] : null;
}

function isExplicitPdfConversion(instruction, files = []) {
  const hasOtherSource = files.some((file) => Buffer.isBuffer(file?.buffer) && !/\.pdf$/iu.test(String(file.name || '')));
  const hasPdfSource = files.some((file) => Buffer.isBuffer(file?.buffer) && /\.pdf$/iu.test(String(file.name || '')));
  return hasOtherSource && !hasPdfSource
    && /\b(?:convierte|convertir|convert|exporta|exportar|export|guarda|guardar|save)\b[^.!?\n]{0,120}\b(?:a|al|en|como|to|as)\s+(?:(?:un|el|a)\s+)?(?:archivo\s+)?pdf\b/iu.test(String(instruction || ''));
}

function requestsSavExcelDelivery(instruction) {
  const request = String(instruction || '');
  return (CREATE_DOC_RE.test(request) || DIRECT_SAV_FILE_REQUEST_RE.test(request))
    && /(?:\bspss\b|\.sav\b)/i.test(request)
    && /(?:\bexcel\b|\.xlsx\b)/i.test(request);
}

function missingRequestedSavExcel(instruction, artifacts = []) {
  if (!requestsSavExcelDelivery(instruction)) return [];
  const formats = new Set(artifacts.map((artifact) => String(artifact?.format || artifact?.filename?.split('.').pop() || '').toLowerCase()));
  return [['sav', 'SAV'], ['xlsx', 'Excel']]
    .filter(([format]) => !formats.has(format))
    .map(([, label]) => label);
}

function completedSavExcelSummary(artifacts = [], verification = null) {
  const names = artifacts.map((artifact) => artifact.filename).filter(Boolean).join(', ');
  if (verification?.comparedCells) {
    return `Entregué ${names}. Verifiqué ${verification.rows} filas × ${verification.columns} preguntas en ambos archivos, ${verification.labelCount} etiquetas en el SAV y ${verification.comparedCells} valores idénticos.`;
  }
  return `Entregué ${names}. El SAV se pudo abrir; todavía no he comparado sus valores con los del Excel, así que no puedo afirmar que coincidan.`;
}

async function collectValidOutputs(sandbox, onEvent = () => {}, editContext = {}) {
  const outputs = await sandbox.collectOutputs();
  for (const out of outputs) {
    const ext = String(out.name).split('.').pop().toLowerCase();
    if (!out.buffer || out.buffer.length === 0) {
      out.valid = false;
      onEvent({ type: 'output_invalid', name: out.name, reason: 'empty_file' });
    } else if (['docx', 'xlsx', 'pptx'].includes(ext)) {
      try {
        assertBoundedOfficePackage(out.buffer);
        out.valid = isValidOoxml(out.buffer);
        if (!out.valid) onEvent({ type: 'output_invalid', name: out.name, reason: 'ooxml_structure' });
      } catch (error) {
        out.valid = false;
        const reason = error?.code === 'OFFICE_PACKAGE_LIMIT_EXCEEDED' ? 'office_package_limit_exceeded' : 'office_package_invalid';
        out.validation = { ok: false, passed: false, reason, engine: 'office_package_preflight' };
        onEvent({ type: 'output_invalid', name: out.name, reason });
      }
    } else if (ext === 'sav') {
      const verdict = await validateSavOutput(sandbox, out);
      out.valid = verdict.ok;
      out.validation = verdict.ok
        ? verdict.validation
        : { ok: false, passed: false, engine: 'pyreadstat', reason: verdict.reason };
      if (!out.valid) onEvent({ type: 'output_invalid', name: out.name, reason: verdict.reason });
    } else {
      out.valid = true;
    }
  }
  for (const out of outputs) {
    const ext = String(out.name || '').split('.').pop().toLowerCase();
    const sources = (editContext.files || []).filter((file) => String(file.name || '').toLowerCase().endsWith(`.${ext}`));
    const source = resolveOutputEditSource(out.name, sources);
    if (out.valid && ext === 'pdf') {
      // The general agent also edits PDFs, outside the document-agent route.
      // Byte inequality proves neither a readable PDF nor a requested edit.
      const requiresPdfSource = editContext.isEdit && !isExplicitPdfConversion(editContext.instruction, editContext.files);
      let proof = requiresPdfSource
        ? (source ? verifyContentChanged(source.buffer, out.buffer, ext) : { passed: false, reason: sources.length ? 'source_ambiguous' : 'source_missing' })
        : { passed: true };
      if (proof.passed) {
        const verdict = await validateEditedPdf({
          originalBuffer: requiresPdfSource ? source.buffer : null,
          editedBuffer: out.buffer,
          instruction: editContext.instruction,
        });
        proof = { passed: verdict.ok, reason: verdict.reason };
      }
      out.valid = proof.passed;
      out.validation = { ...proof, ok: proof.passed, engine: 'agent_runner_pdf_edit' };
      if (!out.valid) onEvent({ type: 'output_invalid', name: out.name, reason: proof.reason });
      continue;
    }
    if (out.valid && sources.length && editContext.isEdit) {
      let proof = source ? verifyContentChanged(source.buffer, out.buffer, ext) : { passed: false, reason: 'source_ambiguous' };
      if (proof.passed && ext === 'pptx') {
        try {
          assertBoundedOfficePackage(source.buffer);
          const adapter = require('../document-editing/pptx-adapter');
          const before = adapter.listPptxSlides(source.buffer);
          const edit = parsePresentationTitleEdit(editContext.instruction, { slides: before });
          if (edit?.slideNumber) proof = verifySlideTitleEdit(source.buffer, out.buffer, edit);
          else if (isScopedSlideMutation(editContext.instruction) && before.length !== adapter.listPptxSlides(out.buffer).length)
            proof = { passed: false, reason: 'unrequested_slide_count_change' };
        } catch {
          proof = { passed: false, reason: 'office_source_invalid' };
        }
      }
      out.valid = proof.passed;
      out.validation = {
        ...proof, ok: proof.passed, engine: 'agent_runner_edit_delta',
        ...(ext === 'sav' && out.validation?.spss ? { spss: out.validation.spss } : {}),
      };
      if (!out.valid) onEvent({ type: 'output_invalid', name: out.name, reason: proof.reason });
    }
  }
  outputs.sort((a, b) => Number(b.valid !== false) - Number(a.valid !== false));
  return outputs;
}

/**
 * A persistent chat workspace (persistKey = chatId) keeps earlier turns'
 * outputs/. Those files are history, never this turn's deliverable: a loop
 * that stopped before editing re-delivered the previous deck as «Listo.
 * Generé …». At turn start they move to tmp/previous-outputs/ (still
 * readable), so outputs/ only holds what this turn writes. The latest version
 * the user works on is staged in uploads/ anyway.
 */
async function archivePreviousOutputs(sandbox) {
  if (!sandbox || !sandbox.persistent || typeof sandbox.exec !== 'function') return false;
  try {
    const res = await sandbox.exec(
      'rm -rf /workspace/tmp/previous-outputs && mkdir -p /workspace/tmp/previous-outputs'
        + ' && find /workspace/outputs -mindepth 1 -maxdepth 1 -exec mv {} /workspace/tmp/previous-outputs/ \\;',
      { timeoutMs: 20_000 },
    );
    return !res || res.exitCode === undefined || res.exitCode === 0;
  } catch (_) {
    return false;
  }
}

// Fallback when the archive could not run: never deliver a file identical to
// one that was already there before the turn.
async function fingerprintOutputs(sandbox) {
  const seen = new Map();
  if (!sandbox || !sandbox.persistent || typeof sandbox.collectOutputs !== 'function') return seen;
  try {
    for (const out of await sandbox.collectOutputs()) {
      if (out && out.name && Buffer.isBuffer(out.buffer)) {
        seen.set(out.name, require('crypto').createHash('sha256').update(out.buffer).digest('hex'));
      }
    }
  } catch (_) { /* no snapshot → nothing is excluded */ }
  return seen;
}

function dropPreviousTurnOutputs(outputs = [], previous = new Map(), onEvent = () => {}) {
  if (!previous || !previous.size) return outputs;
  return (Array.isArray(outputs) ? outputs : []).filter((out) => {
    const hash = out && Buffer.isBuffer(out.buffer)
      ? require('crypto').createHash('sha256').update(out.buffer).digest('hex') : null;
    const unchanged = Boolean(out && hash && previous.get(out.name) === hash);
    if (unchanged) {
      try { onEvent({ type: 'output_invalid', name: out.name, reason: 'previous_turn_output' }); } catch (_) { /* trace only */ }
    }
    return !unchanged;
  });
}

/**
 * The turn's office edits all left the file byte-identical: what the user
 * asked was already in the document. No output-retry nudge («you have NOT
 * produced a deliverable») — the honest answer is «ya estaba así».
 */
function noChangesNeeded(steps = []) {
  const edits = (Array.isArray(steps) ? steps : []).filter((s) => s && s.tool === 'office_edit' && s.ok !== false);
  return edits.length > 0 && edits.every((s) => /^\{"unchanged":true/.test(String(s.resultPreview || '')));
}

/**
 * An office_edit chain (first edit → verification → correction) leaves every
 * version in outputs/; only the LAST link is the deliverable. An output that a
 * later successful office_edit used as its `src` is an intermediate version
 * and is not delivered (never drops everything).
 */
function dropIntermediateOutputs(outputs = [], steps = []) {
  const consumed = new Set();
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step || step.tool !== 'office_edit' || step.ok === false) continue;
    const src = String((step.args && (step.args.src || step.args.path)) || '').replace(/^\/?workspace\//, '');
    if (src.startsWith('outputs/')) consumed.add(src.slice('outputs/'.length));
  }
  if (!consumed.size) return outputs;
  const kept = outputs.filter((out) => !consumed.has(out.name));
  return kept.length ? kept : outputs;
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
  // F4: optional system-prompt suffix (role prompt of an orchestrated
  // sub-agent). Empty for normal single-runner turns.
  systemAppend = '',
  // "Provider:model" picked in the composer (runnerModelSpec): first rung.
  pickedModel = null,
  // F4: text-producing sub-agents (researcher/data_analyst/verifier) may
  // legitimately finish without a file — skip the no-output retry loop for
  // them. Single-runner document turns keep the default (true).
  requireFileOutput = true,
  // F7 (multimodal) injectable seams — tests / provider routing only.
  openaiClient = null,
  synthesize = null,
  computerDriver = null,
  // F8: cross-session memory + skills + per-user MCP. `prisma` is only used
  // by the MCP loader (mcp_servers rows); `memoryStore` / `mcpToolLoader`
  // are injectable for tests. `persistMemory` gates the post-turn episodic
  // note (opt-in on top of the SIRAGPT_AGENT_MEMORY flag).
  prisma = null,
  memoryStore = null,
  mcpToolLoader = null,
  persistMemory = true,
} = {}) {
  const task = String(instruction || '').trim();
  if (!task) throw new Error('runAgentRunner: instruction is required');
  let llm = client || null;
  const resolvedModel = model || defaultModel();

  const abortScope = composeAbortSignals([signal], {
    timeoutMs: resolveMaxRuntimeMs(process.env.SIRAGPT_AGENT_RUNNER_MAX_RUNTIME_MS),
    timeoutReason: 'agent_runner_timeout',
  });
  // F3: guarantee exactly ONE 'cancelled' trace per aborted run, no matter
  // where the abort lands (inside the loop, between phases, in the sandbox).
  const rawOnEvent = onEvent;
  const pairFinalEvents = createSavXlsxFinalEventGate(task, rawOnEvent);
  let cancelledSeen = false;
  onEvent = (ev) => {
    if (ev && ev.type === 'cancelled') {
      if (cancelledSeen) return;
      cancelledSeen = true;
    }
    pairFinalEvents.onEvent(ev);
  };
  let sandbox = null;
  let f7 = null; // F7 (multimodal) extras — cleaned up in finally
  try {
    throwIfAborted(abortScope.signal);
    const surgical = CREATE_DOC_RE.test(task) ? null : trySurgicalPresentationFollowup({ instruction: task, files });
    if (surgical) return surgical;
    // This is an output-integrity gate, not the document-routing classifier:
    // same-format artifacts returned from an existing-file turn must contain
    // a real change unless the user explicitly asked to generate a new file.
    // Keep the generic document pipeline out of AgentRunner's dependency path.
    const editContext = { files, instruction: task,
      isEdit: files.some((file) => Buffer.isBuffer(file?.buffer))
        && (!CREATE_DOC_RE.test(task) || SOURCE_COPY_RE.test(task)) };
    sandbox = await createSandbox({
      driver,
      signal: abortScope.signal,
      persistKey: chatId || null,
    });
    onEvent({
      type: 'sandbox_ready',
      driver: sandbox.driver,
      // F5: never claim isolation that is not there — the local driver
      // reports runtime 'none' / gvisor false.
      runtime: sandbox.runtime || null,
      gvisor: Boolean(sandbox.gvisor),
      persistent: Boolean(sandbox.persistent),
      label: 'Preparando entorno',
    });

    const names = [];
    const priorNames = [];
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i];
      if (!f || !Buffer.isBuffer(f.buffer)) continue;
      const name = sanitizeUploadName(f.name, i);
      if (names.some((staged) => staged.toLowerCase() === name.toLowerCase())) {
        const error = new Error(`Hay varios archivos llamados ${name}. Indica cuál deseas editar; no modifiqué ninguno.`);
        error.code = 'DOCUMENT_EDIT_SOURCE_AMBIGUOUS';
        throw error;
      }
      await sandbox.putFile(`uploads/${name}`, f.buffer);
      names.push(name);
      if (f.isPriorArtifact) priorNames.push(name);
    }
    await sandbox.exec('mkdir -p /workspace/outputs /workspace/previews /workspace/tmp /workspace/uploads', { timeoutMs: 10_000 });
    const previousOutputs = (await archivePreviousOutputs(sandbox)) ? new Map() : await fingerprintOutputs(sandbox);
    const collectTurnOutputs = async () => dropPreviousTurnOutputs(
      await collectValidOutputs(sandbox, onEvent, editContext), previousOutputs, onEvent);
    const officeHelpersPy = loadOfficeHelpersPy();
    if (officeHelpersPy) {
      try { await sandbox.writeFile('tmp/office_helpers.py', officeHelpersPy); } catch (_) { /* agent writes its own code */ }
    }
    // Fail-open: without the engine the agent still edits with execute_python.
    // With the office tools on, a failed install is reported to the admin
    // turn-failure tracker (the user may end up without visual verification).
    const reportOfficeFailure = createOfficeFailureReporter({ userId, chatId });
    try { await installSiraOfficeEngine(sandbox); } catch (err) {
      if (officeEngineEnabled()) {
        reportOfficeFailure({ tool: 'office_engine', code: 'install_failed', error: err && err.message });
      }
    }

    // ── F8 hook: memoria recall (DATA) + tools extra (skills / MCP) ────────
    const f8 = await prepareF8Extras({
      userId, chatId, instruction: task, prisma, memoryStore, mcpToolLoader,
    });
    const isCreateRequest = (CREATE_DOC_RE.test(task) && DOC_NOUN_RE.test(task))
      || requestsSavExcelDelivery(task);
    const baseSystem = buildAgentRunnerPrompt({
      fileNames: names,
      priorArtifactNames: priorNames,
      memoryBlock: f8.memoryBlock,
      creatingNewFile: isCreateRequest && !SOURCE_COPY_RE.test(task),
    });
    const system = systemAppend
      ? `${baseSystem}\n\n${String(systemAppend).trim()}`
      : baseSystem;
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: task },
    ];

    let lastVerify = null;
    const verifies = [];
    const executors = {
      ...makeToolExecutors(sandbox, {
        office: {
          onFailure: reportOfficeFailure,
          visionVerifier: buildVisionVerifier({
            pickedModel: model,
            onFailover: (info) => { try { onEvent({ type: 'vision_failover', ...info }); } catch (_) { /* trace only */ } },
          }),
          attachImages: loopSeesImages(),
          // Stage v2 thumbnails (render / verify) for the timeline.
          thumbs: agentThumbsEnabled(),
          onVerify: (v) => { lastVerify = v; verifies.push(v); recordVerify(v); },
        },
      }),
      ...f8.executors,
    };
    const loopMaxTokens = documentTurnMaxTokens(names);

    // Deterministic fast-paths are allowed ONLY for exact edits on an
    // EXISTING pptx (paint a color, append a thanks slide). Creating a NEW
    // deck must ALWAYS go through the LLM loop so the slide copy answers the
    // user's actual topic — a "crea una ppt + color" stub with filler bullets
    // is exactly the quality failure Phase 1 removes.
    const color = inferColorFromText(task);
    const pptxUpload = names.find((n) => /\.pptx$/i.test(n));
    let fastPathUsed = false;
    if (color && pptxUpload && !isCreateRequest && isSlideBackgroundColorRequest(task)) {
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

    let outputs = await collectTurnOutputs();
    if (fastPathUsed && outputs.filter((o) => o.valid !== false).length > 0) {
      const previewTarget = outputs.find((o) => o.valid !== false);
      onEvent({ type: 'tool_call', tool: 'render_preview', label: 'Verificando resultado', preview: previewTarget.name });
      const preview = await executors.render_preview({ path: `outputs/${previewTarget.name}` });
      const rendered = previewRendered(preview);
      onEvent({
        type: 'tool_result',
        tool: 'render_preview',
        ok: rendered,
        preview,
        label: 'Verificando resultado',
      });
      const fastPathSteps = [
        { tool: color ? 'set_slide_background' : 'execute_python', ok: true },
        { tool: 'render_preview', ok: rendered },
      ];
      if (!rendered) {
        reportOfficeFailure({
          tool: 'render_preview', code: 'preview_failed', fatal: true,
          error: 'La presentación se editó, pero no se pudo renderizar para verificarla.',
        });
        onEvent({ type: 'output_invalid', name: previewTarget.name, reason: 'preview_failed' });
        onEvent({ type: 'outputs', count: 0, names: [], label: 'Sin verificación visual' });
        return {
          finalText: 'No pude verificar visualmente la presentación editada. No entregué el archivo sin comprobar.',
          outputs: [],
          driver: sandbox.driver,
          model: resolvedModel,
          iterations: 0,
          steps: fastPathSteps,
          stoppedReason: 'verification_failed',
        };
      }
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
        steps: fastPathSteps,
        stoppedReason: 'fast_path',
      };
    }

    if (!llm) llm = createRunnerLlmClient({ pickedModel });

    // ── F7 (multimodal) hook ─────────────────────────────────────────────
    // Vision / voice / bounded computer-use extras. Kill switches:
    // SIRAGPT_AGENT_VISION / _VOICE / _COMPUTER (default ON in production,
    // OFF under NODE_ENV=test). Image attachments become real vision
    // content blocks on the FIRST LLM call; tool-produced images are
    // attached by the loop's own F7 hook. Fail-open: a broken multimodal
    // module never blocks the core loop. When a prepareF8Extras sibling
    // lands (memory/skills/MCP), merge its arrays the same way.
    try {
      const { prepareF7Extras } = require('./multimodal');
      f7 = prepareF7Extras({
        files,
        sandbox,
        client: llm,
        model: resolvedModel,
        openaiClient,
        synthesize,
        computerDriver,
      });
      f7.applyToMessages(messages);
    } catch (_) { f7 = null; }
    const extraDefs = [
      ...(f8.toolDefinitions || []),
      ...((f7 && f7.toolDefinitions) || []),
    ];
    const loopTools = extraDefs.length
      ? [...TOOL_DEFINITIONS, ...extraDefs]
      : TOOL_DEFINITIONS;
    const loopExecutors = {
      ...executors,
      ...((f7 && f7.executors) || {}),
    };
    // ── end F7 hook ──────────────────────────────────────────────────────

    let result = await runAgentLoop({
      client: llm,
      model: resolvedModel,
      messages,
      tools: loopTools,
      executors: loopExecutors,
      maxIterations,
      onEvent,
      signal: abortScope.signal,
      maxTokens: loopMaxTokens,
      turnWallMs: documentTurnWallMs(),
    });
    throwIfAborted(abortScope.signal);
    if (result.stoppedReason === 'E_PROVIDER') {
      return { ...result, outputs: [], driver: sandbox.driver, model: resolvedModel };
    }
    outputs = await collectTurnOutputs();

    let outputAttempt = 1;
    while (
      requireFileOutput
      && !abortScope.signal.aborted
      // Out of credits (OpenRouter/Anthropic 402): another loop pass costs
      // latency and cannot succeed — stop retrying and surface the reason.
      && result.stoppedReason !== 'llm_402'
      && !noChangesNeeded(result.steps)
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
        tools: loopTools,
        executors: loopExecutors,
        maxIterations: Math.min(maxIterations, 8),
        onEvent,
        signal: abortScope.signal,
        maxTokens: loopMaxTokens,
        turnWallMs: documentTurnWallMs(),
      });
      throwIfAborted(abortScope.signal);
      if (result.stoppedReason === 'E_PROVIDER') {
        return { ...result, outputs: [], driver: sandbox.driver, model: resolvedModel };
      }
      outputs = await collectTurnOutputs();
    }
    outputs = dropIntermediateOutputs(outputs, result && result.steps);

    // Compare the exact output bytes before persistence or file_artifact SSE.
    // A readable SAV plus an OOXML workbook is insufficient for an explicit
    // 20 × 20 request unless all 400 values and 20 SAV labels agree.
    const pairGate = await applySavXlsxDeliveryGate({ instruction: task, outputs, result, sandbox });
    result = pairGate.result;
    outputs = pairGate.outputs;
    if (pairGate.active && !pairGate.ok && result.stoppedReason === 'verification_failed') {
      onEvent({ type: 'output_invalid', name: 'SAV/Excel', reason: 'sav_xlsx_matrix_invalid' });
    }

    // An edit that ends with its visual verification failed reaches the user
    // unverified: surface it to the admin turn-failure tracker.
    try {
      const verifyFailure = verificationFailureFromSteps(result && result.steps);
      if (verifyFailure) reportOfficeFailure(verifyFailure);
    } catch (_) { /* reporting never breaks a turn */ }
    // F.2 metrics + one [office-edit] line per document turn.
    recordOfficeTurn({ steps: result && result.steps, stoppedReason: result && result.stoppedReason, verifies, chatId });
    if (result && result.stoppedReason === 'final') {
      result = { ...result, finalText: withVisionHonesty(result.finalText, lastVerify) };
    }
    const delivery = assessDelivery(result);
    pairFinalEvents.release({ ok: pairGate.ok, result, deliveryBlocked: delivery.blocked });
    const deliverableOutputs = delivery.blocked
      ? outputs.map((output) => output.valid === false ? output : {
        ...output,
        valid: false,
        validation: { ...output.validation, passed: false,
          reason: delivery.verificationNeeded ? 'verification_incomplete' : 'turn_incomplete' },
      })
      : outputs;
    onEvent({
      type: 'outputs',
      count: delivery.blocked ? 0 : outputs.length,
      names: delivery.blocked ? [] : outputs.map((o) => o.name),
      label: delivery.verificationNeeded || (pairGate.active && !pairGate.ok)
        ? 'Sin verificar' : delivery.blocked ? 'Incompleto' : 'Listo',
    });
    // ── F8 hook: persist ONE short episodic note (opt-in, size-capped) so a
    // follow-up in a NEW conversation for the same user can recall this turn.
    try {
      await require('./memory').persistEpisode({
        userId,
        chatId,
        instruction: task,
        summary: delivery.blocked ? 'El trabajo no terminó o no se verificó; no se entregó.' : result.finalText,
        outputNames: deliverableOutputs.filter((o) => o.valid !== false).map((o) => o.name),
        store: memoryStore,
        persist: persistMemory,
      });
    } catch (_) { /* memory is best-effort */ }
    return { ...result, outputs: deliverableOutputs, driver: sandbox.driver, model: resolvedModel };
  } catch (err) {
    if (abortScope.signal.aborted) {
      try { onEvent({ type: 'cancelled', label: 'Cancelado' }); } catch (_) { /* trace only */ }
    }
    throw err;
  } finally {
    // F7: release the computer-use driver (if one was materialised).
    try { if (f7) await f7.cleanup(); } catch (_) { /* best effort */ }
    // Cancel path included: destroy() removes the docker container / kills
    // the local process group, so a Stop never leaks a sandbox process.
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
  pickedModel = null,
  client,
  signal,
  onEvent = () => {},
  driver,
  maxIterations,
  saveArtifact,
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
    instruction,
  });
  const run = await runAgentRunner({
    files: resolved.files,
    instruction,
    model,
    pickedModel,
    client,
    onEvent,
    driver,
    maxIterations,
    signal,
    chatId,
    userId,
    // F8: prisma feeds the per-user MCP loader (mcp_servers rows); the
    // injectables default to the real stores when absent.
    prisma,
  });
  // A structurally readable OOXML file is not a verified deliverable when the
  // loop exhausted or could not run its verification gate. Never publish a
  // download card or report success for it, including on iteration limits.
  const delivery = assessDelivery(run);
  const valid = delivery.blocked ? []
    : (run.outputs || []).filter((o) => o && o.valid !== false && o.buffer && o.buffer.length);
  const persisted = await persistOutputs({
    outputs: valid,
    userId,
    chatId,
    prisma,
    onEvent,
    saveArtifact,
  });
  const artifacts = persisted.filter((artifact) => artifact?.id && artifact?.downloadUrl && !artifact.error);
  const requestedPair = requestsSavExcelDelivery(instruction);
  // A missing format is an incomplete *partial* delivery. With no delivered
  // files, preserve the loop's real failure (provider, quota, timeout, etc.).
  const missingFormats = artifacts.length ? missingRequestedSavExcel(instruction, artifacts) : [];
  const persistenceFailed = valid.length > 0 && !artifacts.length;
  const rejectedEdit = !valid.length && (run.outputs || []).some((output) => output.validation?.passed === false);
  const summary = delivery.verificationNeeded
    ? 'No pude verificar los archivos generados. No entregué un resultado sin comprobar; vuelve a intentarlo.'
    : delivery.blocked
      ? 'No pude completar los archivos solicitados. No entregué un resultado parcial; vuelve a intentarlo.'
    : missingFormats.length
    ? `No pude completar los dos archivos solicitados: falta ${missingFormats.join(' y ')}. ${artifacts.length ? `Solo entregué ${artifacts.map((artifact) => artifact.filename).join(', ')}.` : 'No entregué archivos.'} Inténtalo de nuevo; no asumiré que el archivo faltante existe.`
    : persistenceFailed ? 'La edición no pudo guardarse como archivo descargable. No entregué un resultado; vuelve a intentarlo.'
    : rejectedEdit ? 'No pude verificar el cambio solicitado en el documento original. No entregué una copia sin cambios ni una edición incorrecta.'
    : requestedPair && artifacts.length ? completedSavExcelSummary(artifacts, run.savXlsxVerification)
    : artifacts.length ? (String(run.finalText || '').trim() || `Listo. Generé ${artifacts.map((a) => a.filename).join(', ')}.`)
      : run.stoppedReason === 'edit_not_applied' ? String(run.finalText || 'No se aplicó la edición.')
        : 'No pude producir un archivo verificado. No entregué un resultado sin comprobar.';
  // A loop that "finished" without a deliverable is a no_output failure for
  // the caller — 'final'/'fast_path' only describe HOW the loop stopped.
  let failReason = persistenceFailed ? 'artifact_persistence_failed' : run.stoppedReason || 'no_output';
  if (failReason === 'final' || failReason === 'fast_path') failReason = 'no_output';
  return {
    ok: !delivery.blocked && artifacts.length > 0 && missingFormats.length === 0,
    summary,
    artifacts,
    steps: run.steps || [],
    iterations: run.iterations,
    driver: run.driver,
    stoppedReason: delivery.blocked ? run.stoppedReason
      : missingFormats.length ? 'requested_artifact_missing' : artifacts.length ? 'agent_runner' : failReason,
    // The delivery gate can block a turn for being incomplete, but it must
    // not replace the provider's primary failure when no file was produced.
    errorMessage: !artifacts.length && run.errorMessage ? run.errorMessage
      : delivery.blocked || missingFormats.length ? summary
        : null,
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
  // F4 — orchestrator-specific honest failures
  budget_exceeded: 'el agente superó el presupuesto de iteraciones/tokens asignado a la tarea y se detuvo para no seguir consumiendo recursos',
  plan_failed: 'el director del agente no pudo construir un plan válido para la tarea multi-paso',
};

function buildAgentRunnerFailureMessage(reason, detail) {
  const key = String(reason || 'no_output');
  if (key === 'E_PROVIDER') return `E_PROVIDER: No pude generar el documento. ${RUNNER_PROVIDER_MESSAGE}`;
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
    && isSlideBackgroundColorRequest(instruction)
    && (STYLE_EDIT_RE.test(instruction) || hasTurnFiles);
  const titleFastPath = isScopedSlideMutation(instruction) || Boolean(parsePresentationTitleEdit(instruction));
  if (!titleFastPath && !colorFastPath && !canCallLlm(params) && !params.client) {
    return {
      ok: false,
      skipped: true,
      summary: '',
      artifacts: [],
      steps: [],
      stoppedReason: params.pickedModel || explicitRunnerModel() ? 'E_PROVIDER' : 'no_llm',
      errorMessage: params.pickedModel || explicitRunnerModel() ? RUNNER_PROVIDER_MESSAGE : null,
    };
  }
  // F4 — genuinely multi-step goals run the hierarchical orchestrator
  // (planner → specialized sub-agents, each a full AgentRunner loop) instead
  // of one single-runner call. Same outcome contract: verified artifacts or
  // an honest failure reason — NEVER the generic pipeline. Kill switch:
  // SIRAGPT_AGENT_ORCHESTRATOR (default ON in production, OFF under test).
  let orchestrator = null;
  try { orchestrator = require('./orchestrator'); } catch (_) { orchestrator = null; }
  if (
    orchestrator
    && orchestrator.orchestratorEnabled()
    && orchestrator.shouldOrchestrate(instruction, {
      files: params.attachedFiles,
      fileIds: params.fileIds,
    })
  ) {
    try {
      return await orchestrator.runOrchestratorForChat(params);
    } catch (err) {
      // User cancellation is not a runner failure — let the caller unwind.
      if (params.signal?.aborted || err?.name === 'AbortError') throw err;
      const reason = err?.code === 'E_PROVIDER' ? 'E_PROVIDER' : isLlmCreditError(err) ? 'llm_402' : 'exception';
      try { console.warn('[agent-runner] orchestrated turn failed:', reason, err && err.message); } catch (_) { /* ignore */ }
      return {
        ok: false,
        skipped: false,
        orchestrated: true,
        summary: '',
        artifacts: [],
        steps: [],
        stoppedReason: reason,
        errorMessage: err?.message || String(err),
      };
    }
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
        pickedModel: params.pickedModel || null,
      }, { connection: params.queueConnection || connection });
      onEventSafe(params.onEvent, { type: 'stage', label: 'Agente trabajando', tool: 'agent_runner', jobId });
      return await waitForAgentRunnerJob({
        jobId,
        connection,
        onEvent: params.onEvent,
        signal: params.signal,
      });
    } catch (err) {
      // User cancellation must unwind, NEVER restart the turn in-process —
      // waitForAgentRunnerJob has already propagated the cancel to the worker.
      if (params.signal?.aborted || err?.name === 'AbortError') throw err;
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
    const reason = err?.code === 'E_PROVIDER' ? 'E_PROVIDER' : isLlmCreditError(err) ? 'llm_402' : 'exception';
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
  pickedModel = null,
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
    pickedModel,
    client,
    signal,
    driver,
    maxIterations,
    onEvent: (ev) => {
      // F3: one canonical stage shape for every runner step (tool_call /
      // tool_result / retry / thought / cancelled), Spanish label + tool name.
      const stage = toStageEvent(ev);
      if (stage) onEventSafe(onStage, stage);
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
const { toStageEvent, STAGE_LABELS } = require('./trace');

// F4 — orchestrator surface (lazy: ./orchestrator requires this module back).
function shouldOrchestrate(text, ctx) {
  return require('./orchestrator').shouldOrchestrate(text, ctx);
}
function steerAgentOrchestratorRun(runId, message) {
  return require('./orchestrator').steer(runId, message);
}
function orchestratorEnabled(env) {
  return require('./orchestrator').orchestratorEnabled(env);
}

module.exports = {
  dropIntermediateOutputs,
  archivePreviousOutputs,
  noChangesNeeded,
  documentTurnWallMs,
  isSlideBackgroundColorRequest,
  fingerprintOutputs,
  dropPreviousTurnOutputs,
  runnerModelSpec,
  shouldRunAgentRunner,
  createRunnerLlmClient,
  resolveRunnerLlmCandidate,
  explicitRunnerModel,
  canCallLlm,
  isRunnerOnlyDocumentTurn,
  shouldOrchestrate,
  steerAgentOrchestratorRun,
  orchestratorEnabled,
  loadFilesByIds,
  logDocumentRouting,
  DOCUMENT_ROUTING_PATHS,
  toStageEvent,
  STAGE_LABELS,
  runAgentRunner,
  runAgentRunnerForChat,
  runAgentRunnerForDocRoute,
  prepareF8Extras,
  executeAgentRunnerTurn,
  buildAgentRunnerFailureMessage,
  canCallLlm,
  defaultModel,
  loadOfficeHelpersPy,
  installSiraOfficeEngine,
  SIRA_OFFICE_ENGINE_REL,
  buildVisionVerifier,
  documentTurnMaxTokens,
  withVisionHonesty,
  MAX_ITERATIONS_DEFAULT,
  MAX_OUTPUT_RETRIES,
  CREATE_DOC_RE,
  DOC_NOUN_RE,
  STYLE_EDIT_RE,
  hasConversationArtifacts,
  collectValidOutputs,
  assessDelivery,
  missingRequestedSavExcel,
  completedSavExcelSummary,
};
