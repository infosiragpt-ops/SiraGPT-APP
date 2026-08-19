'use strict';

/**
 * codex/error-patterns — declarative registry of log/output patterns + a
 * classifier (feature 09, spec §8). BLOCKING patterns surface an "Acción
 * requerida de su parte 🔴" card (action_required event) and end the run;
 * BENIGN patterns are annotated informatively on the action and the loop
 * continues. Adding a pattern = one entry + one test; the classifier never
 * changes.
 *
 * Each pattern: { id, severity:'blocking'|'benign', match(text, ctx)->bool,
 * title, blockedCapabilities[], remediationUrl?, explanation }.
 */

// Boot window during which an ECONNREFUSED to the dev port is normal noise
// (the frontend boots before the backend). Outside it, ECONNREFUSED is NOT
// auto-benign — it may be a genuinely dead dev server.
const BOOT_WINDOW_MS = 15_000;

const PATTERNS = [
  // ── Blocking ──────────────────────────────────────────────────────────────
  {
    id: 'openrouter_402',
    severity: 'blocking',
    match: (t) => /\b402\b/.test(t) && /insufficient credits|insufficient_quota/i.test(t),
    title: 'Sin créditos en OpenRouter',
    blockedCapabilities: ['Generación con modelos de OpenRouter'],
    remediationUrl: 'https://openrouter.ai/credits',
    explanation: 'OpenRouter rechazó la llamada por falta de créditos. Recarga para continuar.',
  },
  {
    id: 'quota_exhausted',
    severity: 'blocking',
    // siraGPT's internal credit 402 (distinct from OpenRouter's): mentions plan/credits/quota.
    match: (t) => /\b402\b/.test(t) && /(plan|cr[eé]ditos?|quota|cuota|l[ií]mite)/i.test(t) && !/openrouter/i.test(t),
    title: 'Cuota de créditos agotada',
    blockedCapabilities: ['Generación con modelos premium'],
    remediationUrl: '/api/free-ia/plans',
    explanation: 'Se agotó tu cuota de créditos del plan. Mejora tu plan para seguir generando.',
  },
  {
    id: 'missing_api_key',
    severity: 'blocking',
    // Auth phrases (space/underscore/dash tolerant) match outright; a bare 401
    // ONLY counts when it carries an HTTP/auth/status context word. This avoids
    // an expensive false positive (spec req. 5): a stray "401" in unrelated tool
    // output — an asset path (img-401.png), an audit count ("401 packages") —
    // must NOT raise a blocking "missing API key" card that kills the run.
    match: (t) =>
      /(api[ _-]?key|unauthorized|invalid[ _-]?api[ _-]?key|missing[ _-]?api[ _-]?key|invalid[ _-]?api|invalid[ _-]?key)/i.test(t) ||
      (/(?:^|[^.\d])401(?=\D|$)/.test(t) &&
        /(http|status|code|c[oó]digo|unauthor|error|auth|response|respuesta|token|key|clave|credential|credencial|forbidden)/i.test(t)),
    title: 'Falta o es inválida una API key del proveedor',
    blockedCapabilities: ['Generación con el proveedor afectado'],
    remediationUrl: '/settings',
    explanation: 'El proveedor rechazó la autenticación. Revisa la API key en Ajustes.',
  },
  {
    id: 'provision_failed',
    severity: 'blocking',
    // Runner unreachable (RunnerError status 0) — the sandbox profile is down.
    match: (t) => /runner unreachable|RunnerError.*status\s*0|ECONNREFUSED.*4097/i.test(t),
    title: 'No se pudo contactar el runner del sandbox',
    blockedCapabilities: ['Workspace', 'Preview', 'Ejecución de comandos'],
    remediationUrl: null,
    explanation: 'El runner no responde. Levanta el perfil "opencode" de docker-compose.',
  },

  // ── Benign ────────────────────────────────────────────────────────────────
  {
    id: 'econnrefused_boot',
    severity: 'benign',
    match: (t, ctx) => {
      const inWindow = ctx && Number.isFinite(ctx.bootElapsedMs) && ctx.bootElapsedMs <= BOOT_WINDOW_MS;
      return inWindow && /ECONNREFUSED/.test(t) && /:(5173|5050|3000|517\d)\b/.test(t);
    },
    title: 'Arranque del frontend',
    blockedCapabilities: [],
    remediationUrl: null,
    explanation: 'El frontend arranca antes que el backend — es normal durante el boot.',
  },
  {
    id: 'peer_deps_warn',
    severity: 'benign',
    match: (t) => /npm WARN|peer dep|deprecated|ERESOLVE could not resolve/i.test(t),
    title: 'Avisos de dependencias',
    blockedCapabilities: [],
    remediationUrl: null,
    explanation: 'Advertencias de dependencias (peer deps / deprecaciones). No bloquean el build.',
  },
  {
    id: 'vite_port_retry',
    severity: 'benign',
    match: (t) => /Port \d+ is in use, trying another one|use --port to specify/i.test(t),
    title: 'Vite reintenta el puerto',
    blockedCapabilities: [],
    remediationUrl: null,
    explanation: 'El puerto estaba ocupado y Vite eligió otro automáticamente. Es normal.',
  },
];

const BY_ID = Object.fromEntries(PATTERNS.map((p) => [p.id, p]));

/**
 * Classify a chunk of text. Returns { pattern, severity } or null. A BLOCKING
 * match always wins over a benign one (even if a benign appeared first); within
 * a severity, declaration order decides.
 */
function classifyText(text, ctx = {}) {
  const s = String(text || '');
  if (!s) return null;
  let firstBenign = null;
  for (const pattern of PATTERNS) {
    let hit = false;
    try { hit = Boolean(pattern.match(s, ctx)); } catch { hit = false; }
    if (!hit) continue;
    if (pattern.severity === 'blocking') return { pattern, severity: 'blocking' };
    if (!firstBenign) firstBenign = pattern;
  }
  return firstBenign ? { pattern: firstBenign, severity: 'benign' } : null;
}

/** Build the action_required event payload from a blocking match + the raw error. */
function toActionRequired(pattern, rawError) {
  return {
    patternId: pattern.id,
    title: pattern.title,
    rawError: String(rawError || '').slice(0, 10_000),
    blockedCapabilities: pattern.blockedCapabilities.slice(),
    remediationUrl: pattern.remediationUrl || undefined,
  };
}

/** Build the benign annotation for an action's outputSummary. */
function benignAnnotation(pattern) {
  return `[diagnóstico] ${pattern.explanation}`;
}

module.exports = { PATTERNS, BY_ID, classifyText, toActionRequired, benignAnnotation, BOOT_WINDOW_MS };
