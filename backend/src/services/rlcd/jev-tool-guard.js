'use strict';

/**
 * RLCD × Jev — tool-call guardrail (fase 2b).
 *
 * Before an agent executes a tool that is not already 'confirm'-tier, ask
 * Jev whether the concrete call (tool + args + what the user asked) is
 * destructive, irreversible or has external side effects. When the
 * calibrated probability clears the threshold the call is routed through
 * the same interactive permission gate as `host_bash`, with a human-readable
 * reason. Read-only tools and media generators are never assessed.
 *
 * The decision is recorded as kind `tool_risk` (choice confirm|auto) and
 * scored by the user's answer: deny ⇒ asking was right (guard_needed),
 * allow ⇒ asking was unnecessary (guard_unneeded). Fail-open: any error ⇒
 * the call proceeds exactly as before.
 */

const typesafe = require('../providers/typesafe');
const config = require('./config');

const READ_ONLY_PATTERNS = [
  /^(web_search|read_url|web_fetch|web_extract|deep_search|read_file|search_docs|search_code|search_graph|rag_retrieve|get_symbol|list_files|list_dir|glob_files|code_grep|memory_recall|session_|active_memory|scientific_search|github_search|github_list_repos|x_search|x_list_mentions|linkedin_search|sunat_|check_ci|monitor_ci|project_read|project_changes|project_preview_status|project_pull_request_checks|decide_with_jev|run_javascript|python_exec|static_check|run_tests|docintel|deep_analyze|compare_documents|browser_(navigate|scroll|screenshot|read)|computer_(screenshot|read|list))/i,
  /^(generate_(image|video|music|speech)|edit_image|create_(chart|document|organigram|mermaid|infographic|dashboard|comparison|process|timeline|kanban|swot|eisenhower|raci|business|pyramid|porters|risk|funnel|value|pestel|radar|user|okr|empathy|lean|balanced|ansoff|bcg|moscow|decision|concept|mindmap|swimlane|artifact)|verify_artifact|finalize|run_skill|run_skill_pipeline)/i,
];

const RISK_CHOICES = Object.freeze({
  read_only: 'Solo lee o consulta información; no cambia nada',
  reversible_write: 'Crea o modifica algo que se puede deshacer fácilmente (borrador, archivo de trabajo, rama nueva, commit local)',
  irreversible: 'Borra, sobrescribe o cambia algo que no se puede recuperar (datos, ficheros del usuario, configuración, historial)',
  external_side_effect: 'Produce efectos fuera del sistema: envía mensajes o correos, publica, paga, compra, despliega a producción, cambia permisos',
});

function shouldAssess(toolName) {
  const n = String(toolName || '');
  if (!n) return false;
  return !READ_ONLY_PATTERNS.some((re) => re.test(n));
}

function isGuardEnabled(env = process.env) {
  const c = config.describe(env);
  return c.flags.jev.value && c.flags.jevToolGuard.value;
}

function buildQuestions() {
  return {
    risk: {
      type: 'choice',
      instructions: {
        tarea: '¿Qué tipo de efecto tendrá ejecutar esta llamada a herramienta tal como está?',
        nota: 'Juzga la llamada concreta (herramienta y argumentos), no la herramienta en abstracto.',
      },
      criteria: { ...RISK_CHOICES },
    },
    irreversible: {
      type: 'noul',
      instructions: '¿Ejecutar esta llamada puede causar una pérdida o un efecto que no se pueda deshacer sin intervención del usuario?',
      criteria: {
        true: 'Sí: borra/sobrescribe datos, envía algo a terceros, gasta dinero o cambia producción',
        false: 'No: consulta, crea algo nuevo o modifica algo fácilmente reversible',
      },
    },
    matches_request: {
      type: 'noul',
      instructions: '¿El usuario pidió explícitamente (o claramente implicó) esta acción concreta?',
      criteria: {
        true: 'El mensaje del usuario pide o autoriza claramente esta acción',
        false: 'La acción va más allá de lo pedido o el usuario no la mencionó',
      },
    },
  };
}

function previewArgs(args, max = 1500) {
  try {
    const s = JSON.stringify(args ?? {});
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch { return '[unserializable]'; }
}

/**
 * @returns {Promise<null|{risk:string, pIrreversible:number, pRequested:number, confidence:number, confirm:boolean, reasonLabel:string, decisionId:string|null, latencyMs:number}>}
 */
async function assessToolCall({ toolName, args, userMessage = '', toolDescription = '', chatId = null, env = process.env, fetchImpl, ledger = null, timeoutMs } = {}) {
  if (!shouldAssess(toolName) || !isGuardEnabled(env)) return null;
  const c = config.describe(env);
  try {
    const res = await typesafe.evaluate({
      state: {
        herramienta: String(toolName),
        descripcion_herramienta: String(toolDescription || '').slice(0, 600),
        argumentos: previewArgs(args),
        peticion_del_usuario: String(userMessage || '').slice(0, 2000),
      },
      questions: buildQuestions(),
      model: c.jev.model,
      env,
      fetchImpl,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : c.jev.timeoutMs,
      retries: 0,
    });
    const risk = typesafe.summarizeAnswer(res.answers.risk);
    const irr = typesafe.summarizeAnswer(res.answers.irreversible);
    const req = typesafe.summarizeAnswer(res.answers.matches_request);
    if (!risk || !irr) return null;
    const pIrr = irr.value;
    const pRisky = (Number(risk.probabilities.irreversible) || 0) + (Number(risk.probabilities.external_side_effect) || 0);
    const raw = Math.max(0, Math.min(1, 0.6 * pIrr + 0.4 * pRisky));
    const cal = ledger && typeof ledger.calibrated === 'function' ? ledger.calibrated('tool_risk', raw).calibrated : raw;
    const unrequested = req ? (1 - req.value) : 0;
    const confirm = cal >= c.thresholds.jevToolConfirm.value || (unrequested >= c.thresholds.jevToolUnrequested.value && raw >= 0.35);
    const reasonLabel = risk.value === 'external_side_effect'
      ? 'efecto externo (enviar, publicar, pagar o desplegar)'
      : risk.value === 'irreversible'
        ? 'cambio difícil de deshacer'
        : (unrequested >= c.thresholds.jevToolUnrequested.value ? 'acción no pedida explícitamente' : 'acción de riesgo moderado');
    let decisionId = null;
    if (ledger && typeof ledger.recordDecision === 'function') {
      decisionId = ledger.recordDecision({
        kind: 'tool_risk',
        choice: `${confirm ? 'confirm' : 'auto'}:${risk.value}`,
        confidence: confirm ? raw : 1 - raw,
        chatId,
        meta: { source: 'jev', tool: String(toolName), pIrreversible: pIrr, pRequested: req ? req.value : null, calibrated: cal, model: res.model, latencyMs: res.latencyMs },
      });
      if (chatId && decisionId && typeof ledger.appendTurn === 'function') ledger.appendTurn(chatId, [decisionId]);
    }
    return { risk: risk.value, pIrreversible: pIrr, pRequested: req ? req.value : null, confidence: risk.confidence, raw, calibrated: cal, confirm, reasonLabel, decisionId, latencyMs: res.latencyMs };
  } catch (err) {
    console.warn(`[rlcd/jev-guard] ${toolName}: ${err && (err.code || err.message)}`);
    return null;
  }
}

/** Score the guard decision with the user's answer to the permission request. */
function recordGuardOutcome(assessment, decision, ledger) {
  try {
    if (!assessment || !assessment.decisionId || !ledger || typeof ledger.recordOutcome !== 'function') return 0;
    const outcome = decision === 'allow' ? 'guard_unneeded' : 'guard_needed';
    return ledger.recordOutcome({ decisionIds: [assessment.decisionId], outcome, source: 'permission' });
  } catch { return 0; }
}

module.exports = { READ_ONLY_PATTERNS, RISK_CHOICES, shouldAssess, isGuardEnabled, buildQuestions, assessToolCall, recordGuardOutcome };
