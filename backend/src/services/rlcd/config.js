'use strict';

/**
 * RLCD configuration — the single reviewable place for every decision kind,
 * threshold and flag the calibrated-decision layer uses. Code elsewhere
 * reads these helpers; humans review this file (TypeSafe's advice: keep
 * questions and thresholds together, not scattered through call sites).
 *
 * Every value can be overridden with an environment variable, so tuning in
 * production never needs a redeploy: change the .env, recreate the backend.
 */

function flagOn(env, name, defaultOn = true) {
  const v = String(env[name] ?? '').trim().toLowerCase();
  if (!v) return defaultOn;
  return !(v === '0' || v === 'false' || v === 'off');
}

function ratio(env, name, fallback) {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : fallback;
}

function integer(env, name, fallback, min = 0) {
  const n = Number(env[name]);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

/** Decision kinds with what they decide and which outcomes score them. */
const DECISION_KIND_DOCS = Object.freeze({
  intent_triage: {
    label: 'Triage de intención',
    decides: 'ejecutar directamente o pedir aclaración antes de actuar',
    outcomes: 'thumb, regenerate, fallo de proveedor',
    deciders: ['heuristic'],
  },
  execution_lane: {
    label: 'Carril de ejecución',
    decides: 'respuesta simple vs bucle agéntico con herramientas',
    outcomes: 'thumb, regenerate, éxito/fallo de herramientas',
    deciders: ['heuristic', 'calibrated'],
  },
  model_route: {
    label: 'Ruta de modelo',
    decides: 'qué modelo/proveedor sirve el turno',
    outcomes: 'thumb, regenerate, fallo de proveedor, TTFB',
    deciders: ['heuristic'],
  },
  compute_mode: {
    label: 'Modo de cómputo',
    decides: 'nivel de razonamiento / test-time compute',
    outcomes: 'thumb, regenerate',
    deciders: ['heuristic'],
  },
  media_intent: {
    label: 'Intención de medios',
    decides: 'generar imagen/vídeo/música/voz, preguntar o solo conversar',
    outcomes: 'éxito/fallo de la herramienta de medios, thumb',
    deciders: ['heuristic', 'calibrated', 'jev'],
  },
});

const THRESHOLD_DOCS = Object.freeze([
  { key: 'laneThreshold', env: 'SIRAGPT_RLCD_LANE_THRESHOLD', def: 0.6, doc: 'Probabilidad calibrada mínima para forzar el bucle agéntico en tareas de código.' },
  { key: 'mediaForce', env: 'SIRAGPT_RLCD_MEDIA_FORCE_THRESHOLD', def: 0.6, doc: 'Probabilidad calibrada mínima para generar medios sin preguntar.' },
  { key: 'mediaAsk', env: 'SIRAGPT_RLCD_MEDIA_ASK_THRESHOLD', def: 0.35, doc: 'Por debajo de force y por encima de esto: pedir confirmación.' },
  { key: 'priorWeight', env: 'SIRAGPT_RLCD_PRIOR_WEIGHT', def: 5, doc: 'Pseudo-muestras que anclan la calibración a la confianza declarada.' },
  { key: 'minBinSamples', env: 'SIRAGPT_RLCD_MIN_BIN_SAMPLES', def: 5, doc: 'Muestras por bin para considerar fiable la tasa observada.' },
]);

const FLAG_DOCS = Object.freeze([
  { key: 'enabled', env: 'SIRAGPT_RLCD_ENABLED', def: true, doc: 'Ledger de decisiones tipadas.' },
  { key: 'laneSteering', env: 'SIRAGPT_RLCD_LANE_STEERING', def: true, doc: 'La calibración puede forzar el carril agéntico.' },
  { key: 'mediaSteering', env: 'SIRAGPT_RLCD_MEDIA_STEERING', def: true, doc: 'La calibración decide generar/preguntar en medios.' },
  { key: 'jev', env: 'SIRAGPT_RLCD_JEV', def: true, doc: 'TypeSafe Jev re-decide la banda incierta (requiere TYPESAFE_API_KEY).' },
  { key: 'persistence', env: 'SIRAGPT_RLCD_PERSIST', def: true, doc: 'Guardar bins y contadores en system_settings.' },
]);

function describe(env = process.env) {
  const thresholds = {};
  for (const t of THRESHOLD_DOCS) {
    thresholds[t.key] = {
      value: t.key === 'priorWeight' || t.key === 'minBinSamples' ? integer(env, t.env, t.def, 1) : ratio(env, t.env, t.def),
      default: t.def,
      env: t.env,
      doc: t.doc,
      overridden: String(env[t.env] ?? '').trim() !== '',
    };
  }
  const flags = {};
  for (const f of FLAG_DOCS) {
    flags[f.key] = { value: flagOn(env, f.env, f.def), default: f.def, env: f.env, doc: f.doc, overridden: String(env[f.env] ?? '').trim() !== '' };
  }
  const jevConfigured = Boolean(String(env.TYPESAFE_API_KEY || '').trim());
  flags.jev.value = flags.jev.value && jevConfigured;
  return {
    kinds: DECISION_KIND_DOCS,
    thresholds,
    flags,
    jev: {
      configured: jevConfigured,
      model: String(env.SIRAGPT_RLCD_JEV_MODEL || 'jev-latest'),
      timeoutMs: integer(env, 'SIRAGPT_RLCD_JEV_TIMEOUT_MS', 1500, 200),
    },
    persistence: {
      intervalMs: integer(env, 'SIRAGPT_RLCD_PERSIST_INTERVAL_MS', 300000, 10000),
      key: 'rlcd.ledger.v2',
    },
  };
}

module.exports = { DECISION_KIND_DOCS, THRESHOLD_DOCS, FLAG_DOCS, describe, flagOn, ratio, integer };
