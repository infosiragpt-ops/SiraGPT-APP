'use strict';

const { isConfigStateMessage } = require('../config-state');
const generation = require('./generation');

/**
 * turn-failures/classify — pure outcome classification for one user turn.
 *
 * A "turn" is one question the user sent (chat /generate, document edit,
 * document generation, agent task). The tracker records ONLY failed turns;
 * a normal answer produces nothing. This module decides whether a finished
 * turn failed, in which category, and builds the human cause string the
 * admin «Causas principales» panel groups by.
 *
 * No I/O, no clock, no Prisma: every input arrives in `outcome`, so the
 * heuristics are unit-testable and never break a turn.
 */

const CATEGORIES = Object.freeze({
  sin_respuesta: Object.freeze({ label: 'Sin respuesta', severity: 'critical', sound: 'strong' }),
  colgado: Object.freeze({ label: 'Se quedó colgado', severity: 'critical', sound: 'strong' }),
  sin_cierre: Object.freeze({ label: 'Turno sin cerrar', severity: 'critical', sound: 'strong' }),
  adjunto_perdido: Object.freeze({ label: 'Adjunto perdido', severity: 'critical', sound: 'strong' }),
  error_visible: Object.freeze({ label: 'Error visible', severity: 'high', sound: 'strong' }),
  herramienta_fallida: Object.freeze({ label: 'Herramienta fallida', severity: 'high', sound: 'strong' }),
  cancelado_por_sistema: Object.freeze({ label: 'Cancelado por el sistema', severity: 'high', sound: 'strong' }),
  respuesta_no_entendible: Object.freeze({ label: 'Respuesta no entendible', severity: 'medium', sound: 'soft' }),
  usuario_reporto: Object.freeze({ label: 'Reportado por el usuario', severity: 'medium', sound: 'soft' }),
});

const SEVERITY_RANK = Object.freeze({ low: 1, medium: 2, high: 3, critical: 4 });

// A turn that produced nothing visible for longer than this is «colgado»
// rather than a quick empty reply.
const HANG_MS = 30_000;

// Error codes emitted by tool/document paths (SSE `error` frames, doc
// routes, agentic stop reasons). Everything else is a provider/transport
// error the user saw.
const TOOL_ERROR_CODE_RE = /agent_runner|document|doc_|edit_failed|tool_error|tool_failed|sandbox|E_SANDBOX|verification|verify|transcri|media_batch|pipeline|github_repo|project_preview|artifact/i;

// Failure codes that are the user's own action or a legitimate clarifying
// question, never a platform failure.
const NON_FAILURE_ERROR_CODE_RE = /^(clarification_required|cancelled|CANCELLED|user_cancelled|aborted_by_user)$/;

const INTERNAL_FENCE_RE = /```(?:agent-task-state|agent-state|sira-state)\n[\s\S]*?(?:\n```|$)/g;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

function str(value, max = 4000) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : String(value);
  return text.length > max ? text.slice(0, max) : text;
}

/** Visible text = what a person reads: internal state fences stripped. */
function stripInternalMarkup(text) {
  return str(text, 200_000).replace(INTERNAL_FENCE_RE, '').replace(HTML_COMMENT_RE, '').trim();
}

/** Artifacts declared inside the last agent-task-state sentinel, if any. */
function countSentinelArtifacts(text) {
  const raw = str(text, 400_000);
  const re = /```agent-task-state\n([\s\S]*?)\n```/g;
  let last = null;
  let m;
  while ((m = re.exec(raw))) last = m[1];
  if (!last) return 0;
  try {
    const state = JSON.parse(last);
    return Array.isArray(state && state.artifacts) ? state.artifacts.length : 0;
  } catch (_) {
    return 0;
  }
}

const ES_WORDS = new Set('de la que el en y los del se las por un para con no una su al es lo como más mas pero sus le ya o este sí si porque esta entre cuando muy sin sobre también tambien me hasta hay donde quien desde todo nos durante todos uno les ni otros ese eso ante ellos esto antes algunos qué que unos yo otro otras otra él tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros puedes quiero necesito hazme dame favor porfavor'.split(' '));
const EN_WORDS = new Set('the and of to is in that it for you with as on are this be was have or not by an at from your can will which would there their what about if has more when been were they we he she his her them these those then than also into only other some could our its do does'.split(' '));

function languageScores(text) {
  const words = str(text, 6000).toLowerCase().match(/[a-záéíóúüñ]+/g) || [];
  if (!words.length) return { es: 0, en: 0, words: 0 };
  let es = 0;
  let en = 0;
  for (const w of words) {
    if (ES_WORDS.has(w)) es += 1;
    if (EN_WORDS.has(w)) en += 1;
  }
  const accentBoost = /[ñáéíóú¿¡]/i.test(text) ? 0.08 : 0;
  return { es: es / words.length + accentBoost, en: en / words.length, words: words.length };
}

function looksSpanish(text) {
  const s = languageScores(text);
  return s.words >= 3 && (s.es >= 0.15 || /[¿¡ñ]/i.test(text)) && s.es > s.en;
}

function looksEnglish(text) {
  const s = languageScores(text);
  return s.words >= 40 && s.en >= 0.14 && s.es < 0.06;
}

function shingles(text, size = 8) {
  const words = str(text, 60_000).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const out = new Set();
  for (let i = 0; i + size <= words.length; i += 1) out.add(words.slice(i, i + size).join(' '));
  return out;
}

// `\b` is ASCII-only in JS: «Generé» / «qué» never end on a \b. Word
// boundaries below use Unicode letter look-arounds instead.
const WB_START = '(?<![\\p{L}\\p{N}_])';
const WB_END = '(?![\\p{L}\\p{N}_])';
const CONTENT_REQUEST_RE = new RegExp(`\\?|¿|${WB_START}(escribe|explica|expl[ií]came|resume|resumen|crea|cr[eé]ame|genera|gen[eé]rame|dame|haz|hazme|redacta|resuelve|calcula|traduce|analiza|compara|lista|busca|ay[uú]dame|dime|cu[aá]l|c[oó]mo|qu[eé]|por qu[eé])${WB_END}`, 'iu');
const EXTRACT_REQUEST_RE = /transcrib|extrae|extraer|copia|copiar|texto (completo|literal|exacto)|literal|ocr|l[eé]e(me)? (el|la|este|esta)|qu[eé] dice|contenido del/i;
const CLAIMS_FILE_RE = new RegExp(`${WB_START}(gener[eé]|cre[eé]|adjunt[eé]|guard[eé]|export[eé]|prepar[eé]|te dejo|aqu[ií] tienes|aqu[ií] est[aá]|descarga(?:lo|la)?)${WB_END}[^.\\n]{0,90}\\.(docx?|xlsx?|pptx?|pdf|csv|png|jpe?g|webp|mp3|mp4|wav|zip)${WB_END}`, 'iu');
const CLAIMS_DOC_RE = new RegExp(`${WB_START}(gener[eé]|cre[eé]|adjunt[eé]|guard[eé]|export[eé])\\s+(el|la|un|una|tu)\\s+(documento|archivo|presentaci[oó]n|excel|word|pdf|hoja de c[aá]lculo|imagen|audio|video|v[ií]deo)${WB_END}`, 'iu');
const LEAKED_MARKUP_RE = /```\s*(tool_call|tool_calls|function_call|agent-task-state)\b|<\/?(tool_call|function_calls|invoke|tool_use|tool_result)\b|\[TOOL_RESULT\b|"tool_calls"\s*:|<\|(im_start|im_end|tool_call|tool)\|>/i;
const STACK_TRACE_RE = /(?:^|\n)\s*at\s+[\w$.<>\[\] ]+\s\((?:\/app\/|\/home\/|\/usr\/|node:internal|[^)]*node_modules)[^)]*\)|(?:TypeError|ReferenceError|SyntaxError|RangeError)\b[^\n]*\n\s+at\s/;

/**
 * Heuristics for «the user got text but can't use it». Conservative on
 * purpose: each rule fires only on unambiguous signals.
 * @returns {Array<{code: string, label: string}>}
 */
function detectUnintelligible({ text, prompt = '', artifactsCount = 0, attachmentTexts = [] } = {}) {
  const reasons = [];
  const visible = stripInternalMarkup(text);
  const rawText = str(text, 200_000);
  if (!visible && !rawText) return reasons;

  if (LEAKED_MARKUP_RE.test(visible)) {
    reasons.push({ code: 'leaked_markup', label: 'Respuesta con marcas internas (llamadas a herramientas)' });
  }
  if (/\[object Object\]/.test(visible)) {
    reasons.push({ code: 'object_object', label: 'Respuesta con «[object Object]»' });
  }
  if (/^\s*(undefined|null|NaN)\s*$/.test(visible)) {
    reasons.push({ code: 'bare_undefined', label: 'Respuesta «undefined»' });
  }
  if (STACK_TRACE_RE.test(visible)) {
    reasons.push({ code: 'stack_trace', label: 'Respuesta con traza de error del servidor' });
  }
  if (!artifactsCount && (CLAIMS_FILE_RE.test(visible) || CLAIMS_DOC_RE.test(visible))) {
    reasons.push({ code: 'claims_missing_file', label: 'Afirma haber generado un archivo que no se entregó' });
  }
  const promptText = str(prompt, 4000);
  if (
    promptText
    && looksSpanish(promptText)
    && visible.length > 400
    && looksEnglish(visible)
    && !/ingl[eé]s|english|translate|traduc/i.test(promptText)
  ) {
    reasons.push({ code: 'wrong_language', label: 'Respuesta en inglés a una pregunta en español' });
  }
  if (
    !artifactsCount
    && visible.length <= 24
    && /^(listo|hecho|ok|okay|done|entendido|claro|perfecto)[.!]*$/i.test(visible)
    && promptText.length > 15
    && CONTENT_REQUEST_RE.test(promptText)
  ) {
    reasons.push({ code: 'bare_ack', label: 'Respondió solo «Listo» sin el contenido pedido' });
  }
  if (
    visible.length >= 300
    && Array.isArray(attachmentTexts)
    && attachmentTexts.length
    && !EXTRACT_REQUEST_RE.test(promptText)
  ) {
    const answer = shingles(visible);
    if (answer.size >= 20) {
      for (const source of attachmentTexts) {
        const src = shingles(source);
        if (!src.size) continue;
        let hits = 0;
        for (const s of answer) if (src.has(s)) hits += 1;
        if (hits / answer.size >= 0.8) {
          reasons.push({ code: 'attachment_echo', label: 'Devolvió el texto del adjunto en lugar de responder' });
          break;
        }
      }
    }
  }
  return reasons;
}

const PROVIDER_LABELS = Object.freeze({
  xai: 'xAI', grok: 'xAI', deepseek: 'DeepSeek', anthropic: 'Anthropic', claude: 'Anthropic',
  openai: 'OpenAI', gemini: 'Gemini', google: 'Gemini', meta: 'Meta', openrouter: 'OpenRouter',
  cerebras: 'Cerebras', mistral: 'Mistral', groq: 'Groq', kimi: 'Kimi', moonshot: 'Kimi',
  typesafe: 'TypeSafe', custom: 'Local', 'z.ai': 'Z.ai', zai: 'Z.ai',
});

function providerLabel(provider) {
  const raw = str(provider, 60).trim();
  if (!raw) return '';
  return PROVIDER_LABELS[raw.toLowerCase()] || raw;
}

// Last generation failure the agent did not recover from: a later success of
// the same kind (it retried) clears an error; a degenerate result (blank
// image, 0-byte file) is what the user saw and never clears.
function unresolvedGenerationFailure(notes) {
  if (!Array.isArray(notes)) return null;
  const recovered = new Set();
  for (let i = notes.length - 1; i >= 0; i -= 1) {
    const n = notes[i];
    if (!n || !n.data) continue;
    if (n.kind === 'generation_ok') recovered.add(n.data.kind);
    else if (n.kind === 'generation_failure' && (n.data.degenerate || !recovered.has(n.data.kind))) return n;
  }
  return null;
}

function lastNote(notes, kind) {
  if (!Array.isArray(notes)) return null;
  for (let i = notes.length - 1; i >= 0; i -= 1) {
    if (notes[i] && notes[i].kind === kind) return notes[i];
  }
  return null;
}

function statusFrom(data) {
  const n = Number(data && (data.status || data.statusCode));
  return Number.isFinite(n) && n >= 100 ? n : null;
}

function providerCause(notes) {
  const failure = lastNote(notes, 'provider_failure') || lastNote(notes, 'provider_attempt_failed');
  if (!failure || !failure.data) return '';
  const d = failure.data;
  const label = providerLabel(d.provider) || 'Proveedor';
  const status = statusFrom(d);
  const reason = str(d.reason || d.code || '', 40).trim();
  if (status) return `${label} ${status}`;
  if (reason && !/^(error|unknown)$/i.test(reason)) return `${label} ${reason}`;
  return `${label}: error del proveedor`;
}

function toolCause(notes, errorCode) {
  const tool = lastNote(notes, 'tool_failure');
  const d = (tool && tool.data) || {};
  const code = str(d.reason || errorCode || '', 80);
  if (/agent_runner/i.test(code) || d.tool === 'agent_runner') return 'Agente de documentos: no entregó el archivo';
  if (/source_preserving|document_edit|edit_failed|FAILED/i.test(code) || d.tool === 'document_edit') return 'Editor de documentos: edición no completada';
  if (/verif/i.test(code)) return 'Editor de documentos: verificación fallida';
  if (/media_batch|transcri/i.test(code)) return 'Transcripción: archivos con fallos';
  if (/github/i.test(code)) return 'GitHub: no se pudo abrir el repositorio';
  if (/project_preview/i.test(code)) return 'Vista previa del proyecto: falló';
  if (/document_generation|pipeline/i.test(code)) return 'Generación de documento: falló';
  if (/sandbox/i.test(code)) return 'Sandbox: comando rechazado';
  return code ? `Herramienta: ${code}` : 'Herramienta: falló';
}

/**
 * Normalise a cause into a stable fingerprint so «xAI 429» from many turns
 * groups together (numbers kept — 429 vs 402 are different causes).
 */
function fingerprintOf(category, cause) {
  return `${category}|${str(cause, 160).toLowerCase().replace(/\s+/g, ' ').replace(/[0-9a-f]{16,}/g, '#').trim()}`;
}

function hasOutput(outcome, visible, finalVisible) {
  return Boolean(visible) || Boolean(finalVisible) || Number(outcome.artifactsCount || 0) > 0;
}

/**
 * Decide whether a finished turn failed.
 * @returns {null | {category, label, severity, sound, cause, reasons: string[]}}
 */
function classifyTurnOutcome(outcome = {}) {
  if (!outcome || outcome.replay) return null;
  const notes = Array.isArray(outcome.notes) ? outcome.notes : [];
  const rawErrorFrames = (Array.isArray(outcome.errorFrames) ? outcome.errorFrames : []).filter(Boolean);
  const errorFrames = rawErrorFrames.filter((f) => !NON_FAILURE_ERROR_CODE_RE.test(str(f.code, 60)));
  // A clarifying question travels as a non-failure error frame on some
  // routes (doc generation): it IS what the user read.
  const clarification = rawErrorFrames
    .filter((f) => NON_FAILURE_ERROR_CODE_RE.test(str(f.code, 60)))
    .map((f) => str(f.message, 2000))
    .join('\n')
    .trim();
  const visible = [stripInternalMarkup(outcome.visibleText), clarification].filter(Boolean).join('\n').trim();
  const finalVisible = stripInternalMarkup(outcome.finalText);
  const durationMs = Math.max(0, Number(outcome.endedAt || 0) - Number(outcome.startedAt || 0));
  const out = (category, cause, reasons = []) => {
    const meta = CATEGORIES[category];
    return {
      category,
      label: meta.label,
      severity: meta.severity,
      sound: meta.sound,
      cause: str(cause, 200) || meta.label,
      reasons,
    };
  };

  // The user pressed Stop (or deleted the chat): their decision, not a failure.
  if (outcome.userStopped && !errorFrames.length) return null;

  const attachmentNote = lastNote(notes, 'attachment_missing');
  const requested = Number(outcome.requestedFiles || 0);
  const loaded = Number(outcome.loadedFiles || 0);
  if (attachmentNote || (requested > 0 && loaded < requested)) {
    const cause = attachmentNote
      ? (/image|imagen|png|jpe?g|webp|gif/i.test(str(attachmentNote.data && (attachmentNote.data.kind || attachmentNote.data.file), 200))
        ? 'Imagen no encontrada al responder'
        : 'Adjunto no encontrado al responder')
      : `Adjunto no cargado (${loaded} de ${requested})`;
    return out('adjunto_perdido', cause, ['attachment_missing']);
  }

  if (outcome.ttfbAborted) {
    return out('colgado', 'Sin primera respuesta del modelo a tiempo (watchdog)', ['ttfb_abort']);
  }

  const status = Number(outcome.statusCode || 0);
  if (outcome.httpFailure) {
    const hf = outcome.httpFailure;
    return out('error_visible', `${hf.method || 'POST'} ${hf.endpoint || outcome.route || ''} → ${hf.status}${hf.code ? ` ${hf.code}` : ''}`.trim(), ['http_status']);
  }

  // The generate route's «never end in silence» guard (services/turn-outcome)
  // wrote an honest message because the turn produced nothing: that text is
  // what the user saw, but the question still failed.
  const guard = lastNote(notes, 'turn_no_output');
  if (guard && guard.data) {
    const guardCategory = str(guard.data.category, 40);
    if (guardCategory === 'adjunto_perdido') {
      return out('adjunto_perdido', 'Imagen no leída: no llegó al modelo', ['turn_no_output', guardCategory]);
    }
    if (guardCategory === 'cancelado_por_sistema') {
      return out('colgado', 'Sin primera respuesta del modelo a tiempo (watchdog)', ['turn_no_output', guardCategory]);
    }
    const pc = providerCause(notes);
    return out('sin_respuesta', pc ? `${pc} → respuesta vacía` : 'Respuesta vacía del modelo', ['turn_no_output', guardCategory || 'sin_respuesta']);
  }

  // A media generation that failed or came back degenerate: the user asked
  // for an image/video/audio and did not get it, whatever the text says.
  const genNote = unresolvedGenerationFailure(notes);
  if (genNote && genNote.data) {
    const d = genNote.data;
    const meta = generation.generationMeta(d.kind);
    return {
      ...out('herramienta_fallida', generation.generationCause(d), ['generation_failure', meta && meta.subtype].filter(Boolean)),
      subtype: meta ? meta.subtype : null,
    };
  }

  const toolFatal = notes.find((n) => n && n.kind === 'tool_failure' && n.data && n.data.fatal);
  if (errorFrames.length) {
    const first = errorFrames[0];
    const code = str(first.code, 80);
    if (TOOL_ERROR_CODE_RE.test(code) || toolFatal) {
      return out('herramienta_fallida', toolCause(notes, code), ['error_frame', code].filter(Boolean));
    }
    const pc = providerCause(notes);
    const cause = pc
      ? `${pc}${first.recovered ? ' → mensaje de respaldo' : ''}`
      : (str(first.message, 120) || code || 'Error mostrado al usuario');
    return out('error_visible', cause, ['error_frame', code].filter(Boolean));
  }

  if (outcome.doneFrame && outcome.doneFrame.ok === false && !/CANCEL/i.test(str(outcome.doneFrame.code, 40))) {
    return out('herramienta_fallida', toolCause(notes, outcome.doneFrame.code || 'document_edit'), ['done_not_ok']);
  }

  if (toolFatal) {
    return out('herramienta_fallida', toolCause(notes, toolFatal.data.reason), ['tool_failure']);
  }

  const partial = notes.find((n) => n && n.kind === 'provider_failure' && n.data && /partial|fallback/.test(str(n.data.code, 40)));
  if (partial && hasOutput(outcome, visible, finalVisible)) {
    return out('error_visible', `${providerCause(notes) || 'Proveedor'} → respuesta cortada`, ['provider_partial']);
  }

  if (!hasOutput(outcome, visible, finalVisible)) {
    if (outcome.signalAborted && !outcome.userStopped) {
      return out('cancelado_por_sistema', 'El sistema canceló el turno antes de responder', ['system_abort']);
    }
    const pc = providerCause(notes);
    if (durationMs > HANG_MS) {
      return out('colgado', pc ? `${pc} → sin respuesta` : `Sin respuesta tras ${Math.round(durationMs / 1000)} s`, ['no_output_slow']);
    }
    return out('sin_respuesta', pc ? `${pc} → respuesta vacía` : 'Respuesta vacía del modelo', ['no_output']);
  }

  const unintelligible = detectUnintelligible({
    text: finalVisible || visible,
    prompt: outcome.prompt,
    artifactsCount: outcome.artifactsCount,
    attachmentTexts: outcome.attachmentTexts,
  });
  if (unintelligible.length) {
    return out('respuesta_no_entendible', unintelligible[0].label, unintelligible.map((r) => r.code));
  }
  if (status >= 500) {
    return out('error_visible', `${outcome.route || 'turno'} → ${status}`, ['http_status']);
  }
  return null;
}

/** 4xx statuses worth recording (not auth / validation / not-found noise). */
const RECORDABLE_4XX = new Set([402, 408, 413, 415, 424, 429]);
const QUOTA_NOISE_RE = /monthly (?:api |video generation |plan |quota |)?limit exceeded|plan quota exceeded|quota exceeded|l[ií]mite mensual/i;

function isRecordableHttpFailure(status, body) {
  const code = Number(status);
  if (!Number.isFinite(code)) return false;
  const text = (() => {
    try { return typeof body === 'string' ? body : JSON.stringify(body || {}); } catch (_) { return ''; }
  })();
  // Provider not configured / feature disabled is a config state, never a
  // failed turn — whatever status the route picked (400, 424, 503…).
  if (isConfigStateMessage(text)) return false;
  if (code >= 500) return true;
  if (!RECORDABLE_4XX.has(code)) return false;
  if (code === 429 && QUOTA_NOISE_RE.test(text)) return false;
  return true;
}

function maxSeverity(a, b) {
  return (SEVERITY_RANK[a] || 0) >= (SEVERITY_RANK[b] || 0) ? a : b;
}

module.exports = {
  CATEGORIES,
  SEVERITY_RANK,
  HANG_MS,
  classifyTurnOutcome,
  detectUnintelligible,
  stripInternalMarkup,
  countSentinelArtifacts,
  fingerprintOf,
  providerLabel,
  isRecordableHttpFailure,
  looksSpanish,
  looksEnglish,
  maxSeverity,
};
