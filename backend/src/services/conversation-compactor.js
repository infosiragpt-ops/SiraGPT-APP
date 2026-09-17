'use strict';

/**
 * Rolling conversation compaction — "cuando se acaba el contexto el software
 * comprime conocimiento y continuamos".
 *
 * Long threads used to be handled only by `context-window.fitMessagesToContext`,
 * which silently DROPS the oldest turns (leaving a one-line breadcrumb). The
 * user experienced that as "se le olvidó lo que hablamos". This module keeps
 * the thread alive instead:
 *
 *   1. `planCompaction` measures the history against the model's real context
 *      window (see `context-window.js` family ladder) and decides, BEFORE the
 *      prompt is assembled, whether the older turns must be folded.
 *   2. `compactChat` writes a structured summary of those turns (LLM first,
 *      deterministic extractive fallback) and persists it on the Chat row
 *      (`contextSummary` / `contextSummaryUntil` / `contextSummaryMeta`).
 *   3. The generate route replays only the rows AFTER `contextSummaryUntil`
 *      verbatim and injects the summary as a cacheable `context-summary`
 *      system block, so the model keeps decisions, facts, files and pending
 *      items from the whole thread.
 *   4. Summaries are rolling: the next compaction folds the previous summary
 *      plus the newly-aged rows, so nothing agreed earlier is lost.
 *
 * Everything here is fail-open: any error means "no compaction this turn",
 * never a broken chat.
 */

const contextWindow = require('./context-window');

const DEFAULTS = Object.freeze({
  // Compact when system + history + prompt + reserved completion exceeds this
  // share of the model's context window.
  triggerRatio: 0.7,
  // Post-turn background compaction kicks in above this share, so the next
  // turn does not pay the summarisation latency inline.
  preemptRatio: 0.5,
  // Absolute cap on verbatim history, even for 1M-token models: replaying
  // 100k+ tokens on every turn is slow, expensive and degrades attention.
  maxHistoryTokens: 80000,
  // Never compact fewer rows than this (nothing to gain).
  minCompactRows: 4,
  // Always keep at least this many recent rows verbatim.
  minKeepTail: 8,
  summaryMaxTokens: 1400,
  transcriptMaxChars: 160000,
  perMessageMaxChars: 6000,
  attachmentExcerptChars: 700,
  timeoutMs: 45000,
});

function envNumber(env, name, fallback) {
  const raw = env && env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getConfig(env = process.env) {
  const disabledFlag = String((env && env.SIRAGPT_CONTEXT_COMPACTION) || '').trim().toLowerCase();
  return {
    enabled: !(disabledFlag === '0' || disabledFlag === 'off' || disabledFlag === 'false'),
    triggerRatio: Math.min(0.95, envNumber(env, 'SIRAGPT_COMPACT_TRIGGER_RATIO', DEFAULTS.triggerRatio)),
    preemptRatio: Math.min(0.9, envNumber(env, 'SIRAGPT_COMPACT_PREEMPT_RATIO', DEFAULTS.preemptRatio)),
    maxHistoryTokens: Math.floor(envNumber(env, 'SIRAGPT_COMPACT_MAX_HISTORY_TOKENS', DEFAULTS.maxHistoryTokens)),
    minCompactRows: DEFAULTS.minCompactRows,
    minKeepTail: Math.floor(envNumber(env, 'SIRAGPT_COMPACT_KEEP_TAIL', DEFAULTS.minKeepTail)),
    summaryMaxTokens: Math.floor(envNumber(env, 'SIRAGPT_COMPACT_SUMMARY_MAX_TOKENS', DEFAULTS.summaryMaxTokens)),
    transcriptMaxChars: DEFAULTS.transcriptMaxChars,
    perMessageMaxChars: DEFAULTS.perMessageMaxChars,
    attachmentExcerptChars: DEFAULTS.attachmentExcerptChars,
    timeoutMs: Math.floor(envNumber(env, 'SIRAGPT_COMPACT_TIMEOUT_MS', DEFAULTS.timeoutMs)),
  };
}

// ─── Row helpers ────────────────────────────────────────────────────────

function parseFiles(files) {
  if (!files) return [];
  try {
    const parsed = typeof files === 'string' ? JSON.parse(files) : files;
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

function roleLabel(role) {
  const r = String(role || '').toUpperCase();
  if (r === 'USER') return 'usuario';
  if (r === 'ASSISTANT') return 'asistente';
  return r.toLowerCase() || 'mensaje';
}

/**
 * Tokens the generate route will spend replaying this row verbatim: the text
 * plus every non-image attachment's extracted text (replayed inline as
 * "Attached file: … Content: …"). Images count a flat vision allowance.
 */
function estimateRowTokens(row) {
  if (!row) return 0;
  let tokens = contextWindow.tokensOfMessage({ content: typeof row.content === 'string' ? row.content : '' });
  for (const file of parseFiles(row.files)) {
    const mime = String(file.mimeType || file.type || '');
    if (/^image\//i.test(mime) || file.type === 'image') {
      tokens += 1100;
      continue;
    }
    const text = typeof file.extractedText === 'string' ? file.extractedText : '';
    tokens += 12 + contextWindow.estimateTokens(text || String(file.name || ''));
  }
  return tokens;
}

function estimateRowsTokens(rows) {
  return (Array.isArray(rows) ? rows : []).reduce((acc, row) => acc + estimateRowTokens(row), 0);
}

/** Move `index` back to the nearest USER row so a user/assistant pair is never split. */
function alignToUserRow(rows, index) {
  let i = Math.max(0, Math.min(index, rows.length));
  while (i > 0 && i < rows.length && String(rows[i].role).toUpperCase() !== 'USER') i -= 1;
  return i;
}

// ─── Planning ───────────────────────────────────────────────────────────

/**
 * Decide whether the older rows must be folded into the summary this turn.
 * Pure: no I/O. Returns the split (rowsToCompact / rowsToKeep) so the caller
 * can replay the tail verbatim.
 */
function planCompaction({
  model,
  rows,
  systemTokens = 0,
  promptTokens = 0,
  reservedCompletionTokens = 0,
  env = process.env,
} = {}) {
  const cfg = getConfig(env);
  const list = Array.isArray(rows) ? rows : [];
  const contextLimit = contextWindow.getContextLimit(model);
  const historyTokens = estimateRowsTokens(list);
  const fixedTokens = Math.max(0, systemTokens) + Math.max(0, promptTokens) + Math.max(0, reservedCompletionTokens);
  const total = fixedTokens + historyTokens;
  const triggerBudget = Math.floor(contextLimit * cfg.triggerRatio);
  const preemptBudget = Math.floor(contextLimit * cfg.preemptRatio);

  const base = {
    enabled: cfg.enabled,
    contextLimit,
    historyTokens,
    totalTokens: total,
    triggerBudget,
    rowCount: list.length,
    rowsToCompact: [],
    rowsToKeep: list,
    shouldCompact: false,
    preemptive: false,
    reason: 'fits',
  };
  if (!cfg.enabled) return { ...base, reason: 'disabled' };

  const overflow = total > triggerBudget;
  const tooLong = historyTokens > cfg.maxHistoryTokens;
  const preemptive = !overflow && !tooLong && (
    total > preemptBudget || historyTokens > Math.floor(cfg.maxHistoryTokens * 0.6)
  );
  if (!overflow && !tooLong) {
    return { ...base, preemptive, reason: preemptive ? 'preemptive' : 'fits' };
  }

  const keepTail = Math.max(contextWindow.getKeepTail(model), cfg.minKeepTail);
  let tailStart = alignToUserRow(list, list.length - keepTail);
  // If even the tail overflows, shrink it pair by pair down to the last exchange.
  const tailBudget = Math.min(triggerBudget - fixedTokens, cfg.maxHistoryTokens);
  while (tailStart < list.length - 2 && estimateRowsTokens(list.slice(tailStart)) > tailBudget) {
    tailStart = alignToUserRow(list, tailStart + 2);
    if (tailStart <= 0) break;
  }
  const rowsToCompact = list.slice(0, tailStart);
  if (rowsToCompact.length < cfg.minCompactRows) {
    return { ...base, reason: 'too-few-rows', preemptive: false };
  }
  return {
    ...base,
    shouldCompact: true,
    preemptive: false,
    rowsToCompact,
    rowsToKeep: list.slice(tailStart),
    keepTail: list.length - tailStart,
    reason: tooLong ? 'history-cap' : 'context-overflow',
  };
}

// ─── Transcript + summarisation ────────────────────────────────────────

function clip(text, max) {
  const s = String(text || '').replace(/\r/g, '').trim();
  if (s.length <= max) return s;
  const head = Math.max(0, Math.floor(max * 0.7));
  const tail = Math.max(0, max - head - 20);
  return `${s.slice(0, head)}\n[… ${s.length - head - tail} caracteres omitidos …]\n${s.slice(s.length - tail)}`;
}

function formatStamp(value) {
  const d = value instanceof Date ? value : (value ? new Date(value) : null);
  if (!d || Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * Plain-text transcript of the rows being folded, with an attachment
 * manifest (name, type, size, excerpt) so the summary can keep track of the
 * files the user shared and what they contained.
 */
function buildTranscript(rows, { previousSummary = '', env = process.env } = {}) {
  const cfg = getConfig(env);
  const list = Array.isArray(rows) ? rows : [];
  const budget = Math.max(20000, cfg.transcriptMaxChars - (previousSummary ? previousSummary.length : 0));
  const perMessage = Math.max(300, Math.min(cfg.perMessageMaxChars, Math.floor(budget / Math.max(1, list.length))));
  const lines = [];
  list.forEach((row, index) => {
    const stamp = formatStamp(row.timestamp);
    lines.push(`[#${index + 1} ${roleLabel(row.role)}${stamp ? ` ${stamp}` : ''}]`);
    lines.push(clip(row.content, perMessage) || '(sin texto)');
    for (const file of parseFiles(row.files)) {
      const name = String(file.name || file.originalName || 'archivo');
      const mime = String(file.mimeType || file.type || 'desconocido');
      const text = typeof file.extractedText === 'string' ? file.extractedText : '';
      const size = text
        ? (text.length >= 1000 ? `${(text.length / 1000).toFixed(1)}k caracteres` : `${text.length} caracteres`)
        : 'sin texto extraído';
      const excerpt = text ? ` — extracto: "${clip(text, cfg.attachmentExcerptChars).replace(/\s+/g, ' ')}"` : '';
      lines.push(`  ↳ adjunto: ${name} (${mime}, ${size})${excerpt}`);
    }
    lines.push('');
  });
  return lines.join('\n').trim();
}

const SUMMARY_SYSTEM_PROMPT = `Eres el módulo de memoria de una conversación larga entre un usuario y un asistente de IA. Vas a recibir (a) el resumen previo, si existe, y (b) la transcripción de los mensajes más antiguos que ya no caben en la ventana de contexto. Produce UN resumen consolidado que reemplace a ambos, para que el asistente pueda continuar la conversación sin perder nada importante.

Reglas:
- Escribe en el idioma de la conversación (si es español, en español).
- No inventes nada; conserva cifras, nombres propios, fechas, URLs, rutas de archivo, fragmentos de código relevantes y citas textuales cortas cuando importen.
- Mantén las instrucciones y preferencias del usuario (tono, formato, idioma, restricciones), aunque se dijeran una sola vez.
- Registra cada archivo compartido o generado: nombre, tipo, qué contiene y qué se hizo con él.
- Registra decisiones tomadas y por qué, y lo que quedó pendiente o sin resolver.
- Si hay un resumen previo, fúndelo con la nueva información (actualiza, no dupliques).
- Máximo ~700 palabras. Sin introducción ni comentarios: solo el resumen.

Usa exactamente estas secciones (omite las vacías):
## Objetivo del usuario
## Decisiones y acuerdos
## Hechos y datos clave
## Archivos y entregables
## Preferencias e instrucciones del usuario
## Pendientes
## Último estado`;

function summaryMessages({ transcript, previousSummary = '' }) {
  const parts = [];
  if (previousSummary && previousSummary.trim()) {
    parts.push(`### Resumen previo (ya consolidado)\n${previousSummary.trim()}`);
  }
  parts.push(`### Mensajes antiguos a consolidar\n${transcript}`);
  parts.push('Devuelve el resumen consolidado ahora.');
  return [
    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

function firstSentence(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length <= max ? s : `${s.slice(0, max - 1).trim()}…`;
}

/**
 * Deterministic fallback when no model is reachable: keeps every user
 * request (first line), the files, and the last assistant answer. Coarse but
 * still far better than dropping the turns.
 */
function extractiveSummary(rows, { previousSummary = '' } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const out = [];
  if (previousSummary && previousSummary.trim()) {
    out.push(clip(previousSummary.trim(), 6000));
    out.push('');
  }
  const requests = [];
  const files = [];
  let lastAssistant = '';
  for (const row of list) {
    const role = String(row.role || '').toUpperCase();
    if (role === 'USER') {
      const line = firstSentence(row.content, 220);
      if (line) requests.push(`- ${line}`);
    } else if (role === 'ASSISTANT') {
      const line = firstSentence(row.content, 600);
      if (line) lastAssistant = line;
    }
    for (const file of parseFiles(row.files)) {
      const name = String(file.name || file.originalName || 'archivo');
      if (!files.includes(name)) files.push(name);
    }
  }
  if (requests.length) {
    out.push('## Objetivo del usuario');
    out.push(...requests.slice(-30));
  }
  if (files.length) {
    out.push('## Archivos y entregables');
    out.push(...files.slice(0, 20).map((name) => `- ${name}`));
  }
  if (lastAssistant) {
    out.push('## Último estado');
    out.push(lastAssistant);
  }
  return out.join('\n').trim();
}

function withTimeout(promise, ms, label) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label || 'operation'} timed out after ${ms}ms`)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Summarise via the caller-supplied completion function. `complete(messages,
 * { maxTokens })` must resolve to the assistant text. Returns null on any
 * failure so the caller can fall back to the extractive summary.
 */
async function summarizeWithModel({ transcript, previousSummary = '', complete, env = process.env } = {}) {
  if (typeof complete !== 'function' || !transcript) return null;
  const cfg = getConfig(env);
  try {
    const text = await withTimeout(
      complete(summaryMessages({ transcript, previousSummary }), { maxTokens: cfg.summaryMaxTokens }),
      cfg.timeoutMs,
      'context compaction',
    );
    const summary = String(text || '').trim();
    // A usable summary has structure; a one-liner or a refusal is not.
    if (summary.length < 40 || !/##\s/.test(summary)) return null;
    return summary;
  } catch (_) {
    return null;
  }
}

// ─── Runtime selection ────────────────────────────────────────────────

const SUMMARIZER_SAFE_PROVIDERS = new Set([
  'OpenRouter', 'DeepSeek', 'Gemini', 'Meta', 'Llama', 'xAI', 'XAI', 'Grok',
  'Cerebras', 'Groq', 'Mistral', 'Kimi', 'Moonshot', 'ZAI', 'OpenAI',
]);

/**
 * Which model writes the summary. Prefers the turn's own model when it is an
 * OpenAI-compatible provider with a real context window (≥ 64k); otherwise a
 * configured fallback ladder (DeepSeek → OpenRouter → Gemini). Returns null
 * when nothing is configured (extractive fallback only).
 */
function pickCompactionRuntime({ provider, model, env = process.env } = {}) {
  const forced = String((env && env.SIRAGPT_COMPACT_MODEL) || '').trim();
  if (forced) {
    const idx = forced.indexOf(':');
    if (idx > 0 && idx < 24) return { provider: forced.slice(0, idx), model: forced.slice(idx + 1), source: 'env' };
    return { provider: provider || 'OpenRouter', model: forced, source: 'env' };
  }
  if (
    provider && model
    && SUMMARIZER_SAFE_PROVIDERS.has(String(provider))
    && contextWindow.getContextLimit(model) >= 65536
  ) {
    return { provider: String(provider), model: String(model), source: 'turn' };
  }
  if (env && env.DEEPSEEK_API_KEY) return { provider: 'DeepSeek', model: 'deepseek-chat', source: 'fallback' };
  if (env && env.OPENROUTER_API_KEY) return { provider: 'OpenRouter', model: 'deepseek/deepseek-v4-pro', source: 'fallback' };
  if (env && (env.GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY)) {
    return { provider: 'Gemini', model: env.GEMINI_VISION_MODEL || 'gemini-3.5-flash', source: 'fallback' };
  }
  return null;
}

// ─── Prompt block ───────────────────────────────────────────────────────

function summaryBlock(summary, meta) {
  const text = String(summary || '').trim();
  if (!text) return '';
  const covered = Number(meta && meta.coveredMessages) || 0;
  const scope = covered > 0
    ? `Los ${covered} mensajes más antiguos de esta conversación`
    : 'Los mensajes más antiguos de esta conversación';
  return `\n\n## Memoria del hilo (contexto comprimido)\n${scope} se resumieron para seguir dentro de la ventana de contexto. Trata este resumen como hechos ya establecidos con el usuario (decisiones, datos, archivos, preferencias y pendientes); no pidas que repita nada de lo que aparece aquí. Los mensajes recientes llegan completos a continuación y prevalecen si contradicen el resumen.\n\n${text}\n`;
}

// ─── Persistence ────────────────────────────────────────────────────────

const SUMMARY_SELECT = Object.freeze({
  contextSummary: true,
  contextSummaryUntil: true,
  contextSummaryMeta: true,
});

async function loadChatSummaryState(prisma, chatId) {
  if (!prisma || !chatId) return null;
  try {
    const chat = await prisma.chat.findUnique({ where: { id: chatId }, select: SUMMARY_SELECT });
    if (!chat || !chat.contextSummary) return null;
    return chat;
  } catch (_) {
    return null;
  }
}

/** Prisma `where` for the verbatim history: live rows after the summary cut. */
function historyWhere(chatId, state) {
  const where = { chatId, deletedAt: null };
  const until = state && state.contextSummary && state.contextSummaryUntil;
  if (until) where.timestamp = { gt: until };
  return where;
}

const inFlight = new Map();

/**
 * Fold `rows` (oldest first, all older than the kept tail) into the chat's
 * rolling summary and persist it. Serialised per chat.
 */
async function compactChat({
  prisma,
  chatId,
  rows,
  previousSummary = '',
  previousMeta = null,
  complete = null,
  model = null,
  runtime = null,
  env = process.env,
  now = () => new Date(),
} = {}) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!chatId || list.length === 0) return { ok: false, reason: 'nothing-to-compact' };
  if (inFlight.has(chatId)) return inFlight.get(chatId);

  const job = (async () => {
    const transcript = buildTranscript(list, { previousSummary, env });
    let summary = await summarizeWithModel({ transcript, previousSummary, complete, env });
    let source = 'llm';
    if (!summary) {
      summary = extractiveSummary(list, { previousSummary });
      source = 'extractive';
    }
    if (!summary) return { ok: false, reason: 'empty-summary' };

    const last = list[list.length - 1];
    const until = last.timestamp instanceof Date ? last.timestamp : new Date(last.timestamp || Date.now());
    const coveredBefore = Number(previousMeta && previousMeta.coveredMessages) || 0;
    const meta = {
      version: 1,
      coveredMessages: coveredBefore + list.length,
      rounds: (Number(previousMeta && previousMeta.rounds) || 0) + 1,
      summaryTokens: contextWindow.estimateTokens(summary),
      foldedTokens: estimateRowsTokens(list),
      source,
      model: runtime && runtime.model ? runtime.model : (model || null),
      at: now().toISOString(),
    };
    if (prisma) {
      await prisma.chat.update({
        where: { id: chatId },
        data: { contextSummary: summary, contextSummaryUntil: until, contextSummaryMeta: meta },
      });
    }
    return { ok: true, summary, until, meta, coveredMessages: list.length, source };
  })().catch((error) => ({ ok: false, reason: error && error.message ? error.message : String(error) }))
    .finally(() => inFlight.delete(chatId));

  inFlight.set(chatId, job);
  return job;
}

/**
 * Editing or deleting a message that the summary already covers would leave
 * the summary describing a reality that no longer exists — drop it so the
 * next turn rebuilds from the live rows.
 */
async function invalidateSummaryIfCovered({ prisma, chatId, timestamp } = {}) {
  if (!prisma || !chatId) return false;
  try {
    const chat = await prisma.chat.findUnique({ where: { id: chatId }, select: SUMMARY_SELECT });
    if (!chat || !chat.contextSummary || !chat.contextSummaryUntil) return false;
    const ts = timestamp instanceof Date ? timestamp : (timestamp ? new Date(timestamp) : null);
    if (ts && ts.getTime() > new Date(chat.contextSummaryUntil).getTime()) return false;
    await prisma.chat.update({
      where: { id: chatId },
      data: { contextSummary: null, contextSummaryUntil: null, contextSummaryMeta: null },
    });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Post-turn, fire-and-forget: when the thread is past the pre-emptive
 * threshold, fold the older rows now so the next turn starts light.
 */
async function maybeCompactInBackground({
  prisma,
  chatId,
  model,
  systemTokens = 0,
  reservedCompletionTokens = 0,
  complete = null,
  runtime = null,
  env = process.env,
} = {}) {
  if (!prisma || !chatId) return { ok: false, reason: 'no-chat' };
  try {
    const state = await loadChatSummaryState(prisma, chatId);
    const rows = await prisma.message.findMany({
      where: historyWhere(chatId, state),
      orderBy: { timestamp: 'asc' },
      select: { id: true, role: true, content: true, files: true, timestamp: true },
    });
    const cfg = getConfig(env);
    const plan = planCompaction({
      model,
      rows,
      systemTokens,
      reservedCompletionTokens,
      env: { ...env, SIRAGPT_COMPACT_TRIGGER_RATIO: String(cfg.preemptRatio), SIRAGPT_COMPACT_MAX_HISTORY_TOKENS: String(Math.floor(cfg.maxHistoryTokens * 0.6)) },
    });
    if (!plan.shouldCompact) return { ok: false, reason: plan.reason };
    return await compactChat({
      prisma,
      chatId,
      rows: plan.rowsToCompact,
      previousSummary: state ? state.contextSummary : '',
      previousMeta: state ? state.contextSummaryMeta : null,
      complete,
      model,
      runtime,
      env,
    });
  } catch (error) {
    return { ok: false, reason: error && error.message ? error.message : String(error) };
  }
}

module.exports = {
  DEFAULTS,
  SUMMARY_SYSTEM_PROMPT,
  getConfig,
  estimateRowTokens,
  estimateRowsTokens,
  planCompaction,
  buildTranscript,
  summaryMessages,
  extractiveSummary,
  summarizeWithModel,
  pickCompactionRuntime,
  summaryBlock,
  loadChatSummaryState,
  historyWhere,
  compactChat,
  invalidateSummaryIfCovered,
  maybeCompactInBackground,
  __test: { alignToUserRow, clip, parseFiles, inFlight },
};
