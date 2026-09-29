'use strict';

/**
 * F3 — Uniform SSE traces for AgentRunner steps.
 *
 * Every internal runner/loop/queue event is normalized into ONE canonical
 * SSE payload the chat UI already consumes:
 *
 *   { type: 'stage', step, label, tool, iteration?, attempt?, ok?, preview? }
 *
 * - `label` is the Spanish stage the UI renders ("Ejecutando código",
 *   "Verificando resultado", "Reintentando", "Listo", "Cancelado"…).
 * - `step` preserves the underlying event kind (tool_call / tool_result /
 *   retry / thought / …) so richer clients can build a Claude-Code-style
 *   timeline without a contract change.
 * - `tool` always carries a tool name ('agent_runner' when the event is not
 *   tied to a specific tool).
 *
 * toStageEvent returns `null` for events that must NOT render as a stage
 * (file_artifact, job_done, internal markers) — callers forward those on
 * their own channel or drop them.
 *
 * Stage v2 (edición milimétrica, docs/specs/edicion-milimetrica/SPEC.md §7
 * D.2) only ADDS fields; every v1 field keeps its meaning:
 *
 *   callId       pairs a tool_call with its tool_result (one timeline row)
 *   description  the model's own phrase for the step (≤120), also the label
 *   kind         icon family: terminal | document | search | web | edit |
 *                image | check | thinking (KIND_BY_TOOL)
 *   status       running (tool_call) → done | error (tool_result)
 *   detail       tool_call: code / command / path / ops (≤600, secrets
 *                redacted); tool_result: the result preview
 *   thumbs       ≤2 `data:image/…;base64` thumbnails (render / verify)
 *
 * The pairing fields (callId, kind, status, detail) ride on events that
 * carry a callId — every loop tool call — so legacy producers (queue fast
 * paths, orchestrator) keep the exact v1 shape.
 */

const { KIND_BY_TOOL } = require('./tools.office');

const STAGE_LABELS = {
  thinking: 'Pensando',
  preparing: 'Preparando entorno',
  working: 'Agente trabajando',
  executing: 'Ejecutando código',
  verifying: 'Verificando resultado',
  retrying: 'Reintentando',
  done: 'Listo',
  cancelled: 'Cancelado',
  error: 'Error',
  // F4 — orchestrator stages
  planning: 'Planificando',
  planReady: 'Plan listo',
  delegating: 'Delegando a sub-agente',
  subagentDone: 'Sub-agente listo',
  replanning: 'Replanificando',
  budgetExceeded: 'Presupuesto agotado',
  steered: 'Instrucción recibida',
  // Edición milimétrica — default phrase when the model sent no description.
  reading: 'Leyendo el documento',
  listing: 'Revisando los archivos',
  editing: 'Editando el documento',
  comparing: 'Comparando antes y después',
};

/** Tools whose whole purpose is verification, not mutation. */
const VERIFY_TOOLS = new Set(['render_preview', 'verify_visual']);

// render_preview keeps «Verificando resultado» (F3 contract); the office
// tools get their own phrase.
const TOOL_CALL_LABELS = Object.freeze({
  // «Ejecutando código» for a file listing misled the timeline.
  list_files: STAGE_LABELS.listing,
  inspect_document: STAGE_LABELS.reading,
  office_edit: STAGE_LABELS.editing,
  verify_visual: STAGE_LABELS.comparing,
});

const THINKING_TYPES = new Set(['iteration_start', 'thought']);
const STAGE_KINDS = new Set(['terminal', 'document', 'search', 'web', 'edit', 'image', 'check', 'thinking']);
const MAX_DESCRIPTION_CHARS = 120;
const MAX_DETAIL_CHARS = 600;
const MAX_THUMBS = 2;
const THUMB_DATA_URL_RE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

// Credentials that may appear in code/commands the model writes. The detail
// is shown to the user and persisted: never echo a secret.
const SECRET_PATTERNS = [
  [/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*/g, '[secreto]'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[secreto]'],
  [/\bxai-[A-Za-z0-9_-]{8,}/gi, '[secreto]'],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, '[secreto]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[secreto]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[secreto]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[secreto]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[secreto]'],
  [/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [secreto]'],
  [/\b(api[_-]?key|secret|token|password|passwd|pwd|authorization)(\s*["']?\s*[:=]\s*["']?)[^\s"',;)]+/gi, '$1$2[secreto]'],
];
const BINARY_BLOB_RE = /[A-Za-z0-9+/]{200,}={0,2}/g;

const NON_STAGE_TYPES = new Set(['file_artifact', 'job_done', 'job_error', 'output_invalid']);

function labelForToolCall(tool) {
  const name = String(tool || '');
  if (TOOL_CALL_LABELS[name]) return TOOL_CALL_LABELS[name];
  return VERIFY_TOOLS.has(name)
    ? STAGE_LABELS.verifying
    : STAGE_LABELS.executing;
}

/** One line, no control characters, capped. */
function cleanPhrase(value, max = MAX_DESCRIPTION_CHARS) {
  if (typeof value !== 'string') return '';
  return redactSecrets(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function redactSecrets(text) {
  let out = String(text == null ? '' : text);
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out.replace(BINARY_BLOB_RE, '[datos binarios]');
}

function capDetail(text, max = MAX_DETAIL_CHARS) {
  const clean = redactSecrets(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ')
    .trim();
  if (!clean) return '';
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function compactJson(value) {
  try { return JSON.stringify(value); } catch (_) { return ''; }
}

/**
 * What the step ran, for the expandable detail of its timeline row:
 * code / command / path / ops. ≤600 characters, secrets redacted.
 */
function previewArgs(tool, args) {
  if (!args || typeof args !== 'object') return '';
  const name = String(tool || '');
  let text = '';
  switch (name) {
    case 'execute_python':
      text = args.code;
      break;
    case 'execute_bash':
    case 'bash':
      text = args.command;
      break;
    case 'office_edit': {
      const src = args.src || args.path || '';
      const head = `${src} → ${args.dst || 'outputs/'}${args.track_changes ? ' (control de cambios)' : ''}`;
      const ops = Array.isArray(args.ops) ? args.ops.map((op) => compactJson(op)).join('\n') : '';
      text = ops ? `${head}\n${ops}` : head;
      break;
    }
    case 'verify_visual': {
      const head = args.before ? `${args.before} → ${args.after || ''}` : String(args.after || '');
      const items = Array.isArray(args.checklist)
        ? args.checklist.map((c, i) => `${i + 1}. ${cleanPhrase(String(c), 200)}`).join('\n')
        : '';
      text = items ? `${head}\n${items}` : head;
      break;
    }
    case 'inspect_document':
    case 'render_preview': {
      const extras = ['query', 'sheet', 'slide', 'pages', 'start', 'limit']
        .filter((k) => args[k] !== undefined && args[k] !== null && args[k] !== '')
        .map((k) => `${k}: ${typeof args[k] === 'string' ? args[k] : compactJson(args[k])}`);
      text = [args.path || '', ...extras].filter(Boolean).join('\n');
      break;
    }
    default: {
      if (typeof args.path === 'string' && !args.content) {
        text = args.path;
      } else {
        const { description: _omit, ...rest } = args;
        text = compactJson(rest);
      }
    }
  }
  return capDetail(typeof text === 'string' ? text : compactJson(text));
}

/** Only real image thumbnails travel to the client (never arbitrary URLs). */
function sanitizeThumbs(thumbs) {
  if (!Array.isArray(thumbs)) return [];
  return thumbs
    .filter((t) => typeof t === 'string' && THUMB_DATA_URL_RE.test(t))
    .slice(0, MAX_THUMBS);
}

/** Stage v2 fields (SPEC §7 D.2) — added to `base`, nothing existing changes. */
function applyStageV2(base, ev, type) {
  const callId = ev.callId != null ? String(ev.callId).slice(0, 120) : '';
  const description = cleanPhrase(ev.description);
  if (description) base.description = description;
  const thumbs = sanitizeThumbs(ev.thumbs);
  if (thumbs.length) base.thumbs = thumbs;
  if (THINKING_TYPES.has(type)) {
    base.kind = 'thinking';
    return;
  }
  if (!callId || (type !== 'tool_call' && type !== 'tool_result')) return;
  base.callId = callId;
  // Producers that know their icon family (the docx engine) send `kind`.
  const kind = (typeof ev.kind === 'string' && STAGE_KINDS.has(ev.kind) ? ev.kind : null)
    || KIND_BY_TOOL[String(ev.tool || '')];
  if (kind) base.kind = kind;
  if (type === 'tool_call') {
    base.status = 'running';
    const detail = previewArgs(ev.tool, ev.args);
    if (detail) base.detail = detail;
  } else {
    base.status = ev.ok === false ? 'error' : 'done';
    const detail = ev.preview != null ? capDetail(ev.preview, 400) : '';
    if (detail) base.detail = detail;
  }
}

/**
 * SIRAGPT_AGENT_THUMBS: thumbnails in the stage SSE. Default on, off under
 * NODE_ENV=test (SPEC §9 F.3); '0'/'false' turns it off, '1' forces it on.
 */
function agentThumbsEnabled(env = process.env) {
  const raw = String((env && env.SIRAGPT_AGENT_THUMBS) ?? '').trim().toLowerCase();
  if (raw) return !['0', 'false', 'off', 'no'].includes(raw);
  return String((env && env.NODE_ENV) || '') !== 'test';
}

/**
 * Normalize any AgentRunner event into the canonical `type: 'stage'` SSE
 * payload, or `null` when the event should not render as a stage.
 *
 * Existing explicit labels win (the loop already speaks Spanish); the map
 * below only fills gaps so EVERY step of a live run shows a trace.
 */
function toStageEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const type = String(ev.type || '');
  if (!type || NON_STAGE_TYPES.has(type)) return null;
  const label = typeof ev.label === 'string' ? redactSecrets(ev.label) : ev.label;

  const base = {
    type: 'stage',
    step: type === 'stage' ? (ev.step || 'stage') : type,
    tool: ev.tool || 'agent_runner',
  };
  if (ev.iteration != null) base.iteration = ev.iteration;
  if (ev.attempt != null) base.attempt = ev.attempt;
  if (ev.ok !== undefined) base.ok = ev.ok;
  if (ev.preview != null) base.preview = redactSecrets(ev.preview);
  applyStageV2(base, ev, type);

  switch (type) {
    case 'stage':
      return { ...base, label: label || STAGE_LABELS.working };
    case 'iteration_start':
    case 'thought':
      return { ...base, label: label || STAGE_LABELS.thinking };
    case 'sandbox_ready':
      return { ...base, label: label || STAGE_LABELS.preparing };
    case 'tool_call':
      return { ...base, label: base.description || label || labelForToolCall(ev.tool) };
    case 'tool_result':
      return {
        ...base,
        label: base.description || label || (ev.ok === false ? STAGE_LABELS.retrying : STAGE_LABELS.verifying),
      };
    case 'retry':
      return { ...base, label: label || STAGE_LABELS.retrying };
    case 'final':
    case 'outputs':
      return { ...base, label: label || STAGE_LABELS.done };
    case 'cancelled':
    case 'job_cancelled':
      return { ...base, label: label || STAGE_LABELS.cancelled };
    // F4 — orchestrator events (planner + sub-agent delegation).
    case 'orchestrator_start':
    case 'plan_start':
      return { ...base, label: label || STAGE_LABELS.planning };
    case 'plan_ready':
      return { ...base, label: label || STAGE_LABELS.planReady };
    case 'node_start':
      return { ...base, label: label || STAGE_LABELS.delegating };
    case 'node_done':
      return { ...base, label: label || STAGE_LABELS.subagentDone };
    case 'replanning':
      return { ...base, label: label || STAGE_LABELS.replanning };
    case 'budget_exceeded':
      return { ...base, label: label || STAGE_LABELS.budgetExceeded };
    case 'steered':
      return { ...base, label: label || STAGE_LABELS.steered };
    case 'error':
      return {
        ...base,
        label: label || STAGE_LABELS.error,
        preview: base.preview != null ? base.preview : (ev.message ? redactSecrets(ev.message) : undefined),
      };
    default:
      // Unknown events only render when they already carry a label.
      return label ? { ...base, label } : null;
  }
}

module.exports = {
  STAGE_LABELS,
  VERIFY_TOOLS,
  toStageEvent,
  labelForToolCall,
  previewArgs,
  redactSecrets,
  sanitizeThumbs,
  agentThumbsEnabled,
};
