'use strict';

/**
 * triage-ensemble
 *
 * Combina N judges ligeros para mejorar la calibración del triage en
 * la zona gris [0.5, 0.8) sin sumar latencias. Corre los judges en
 * paralelo con un budget global de timeout (default 350ms) y vota por
 * mayoría. En empate, conservative → 'execute' (no preguntar).
 *
 * Por qué importa:
 *   - Un solo judge puede fallar o sesgarse en casos limítrofes.
 *   - Con 2-3 judges baratos (Gemini Flash + Haiku 4.5 + Groq Llama),
 *     el ECE baja sin hacer la peor decisión peor.
 *
 * Política de fusión:
 *   - Si los judges activos están de acuerdo (todos 'execute' o todos
 *     'ask') → ese verdict.
 *   - Si hay desacuerdo (split N vs M) → mayoría. Si empate → 'execute'
 *     (defaulteamos a no bloquear).
 *   - Si solo uno sobrevive (los otros timeout/error) → ese verdict.
 *   - Si TODOS fallan → execute (mismo fallback que un judge solo).
 *
 * La pregunta que se devuelve cuando 'ask' es la del judge con mayor
 * peso o, si empatan, la del primer judge en orden.
 *
 * El ensemble es PURO en su fusión y testable sin red. El caller pasa
 * judges ya construidos (vía adapters de intent-triage-judge.js).
 */

const DEFAULT_BUDGET_MS = 350;

function buildEnsembleJudge({ judges = [], budgetMs = DEFAULT_BUDGET_MS } = {}) {
  const activeJudges = (Array.isArray(judges) ? judges : []).filter((j) => typeof j === 'function');
  if (activeJudges.length === 0) return null;
  return async function ensembleJudge({ prompt, recentTurns, hintedQuestion }) {
    const verdicts = await raceAll(activeJudges, { prompt, recentTurns, hintedQuestion }, budgetMs);
    return fuseVerdicts(verdicts);
  };
}

/**
 * raceAll — lanza todos los judges en paralelo con un budget global.
 * Cada judge tiene su propia promesa que se resuelve en éxito, error,
 * o timeout. Esperamos a TODOS pero limitamos la espera al budget; los
 * que no completen se marcan como timeout.
 *
 * Devuelve Array<{status: 'fulfilled'|'rejected', value?, reason?, ms}>.
 */
async function raceAll(judges, args, budgetMs) {
  const t0 = Date.now();
  const wrapped = judges.map((judge, idx) => {
    const start = Date.now();
    const controller = (typeof AbortController === 'function') ? new AbortController() : null;
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        // Abort the underlying provider fetch so a losing/over-budget judge
        // stops consuming a connection + provider quota on the shared pool
        // instead of running to completion after we've stopped waiting.
        if (controller) { try { controller.abort(); } catch { /* noop */ } }
        resolve({ status: 'rejected', reason: 'timeout', ms: Date.now() - start, idx });
      }, budgetMs);
      Promise.resolve()
        .then(() => judge({ ...args, signal: controller ? controller.signal : undefined }))
        .then(
          (value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ status: 'fulfilled', value, ms: Date.now() - start, idx });
          },
          (err) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({
              status: 'rejected',
              reason: (err && err.message) ? String(err.message).slice(0, 60) : 'error',
              ms: Date.now() - start,
              idx,
            });
          },
        );
    });
  });
  const results = await Promise.all(wrapped);
  return { results, totalMs: Date.now() - t0 };
}

/**
 * fuseVerdicts — pura. Acepta el resultado de raceAll y devuelve
 * { action, question?, reason, agreement: 'unanimous'|'majority'|'split'|'fallback' }.
 */
function fuseVerdicts({ results = [], totalMs = 0 } = {}) {
  const fulfilled = results.filter((r) => r.status === 'fulfilled' && r.value && typeof r.value.action === 'string');
  if (fulfilled.length === 0) {
    return { action: 'execute', reason: 'all_judges_failed', agreement: 'fallback', n: results.length, totalMs };
  }

  // Contar votos
  let asks = 0, executes = 0;
  let askQuestion = null;
  for (const r of fulfilled) {
    if (r.value.action === 'ask') {
      asks++;
      if (!askQuestion && r.value.question) askQuestion = String(r.value.question);
    } else {
      executes++;
    }
  }

  // Decisión de voto: mayoría estricta. Empate → conservative 'execute'.
  if (asks === fulfilled.length) {
    return {
      action: 'ask', question: askQuestion || null,
      reason: 'unanimous_ask', agreement: 'unanimous', n: fulfilled.length, totalMs,
    };
  }
  if (executes === fulfilled.length) {
    return {
      action: 'execute',
      reason: 'unanimous_execute', agreement: 'unanimous', n: fulfilled.length, totalMs,
    };
  }
  if (asks > executes) {
    return {
      action: 'ask', question: askQuestion || null,
      reason: `majority_ask_${asks}_of_${fulfilled.length}`, agreement: 'majority', n: fulfilled.length, totalMs,
    };
  }
  if (executes > asks) {
    return {
      action: 'execute',
      reason: `majority_execute_${executes}_of_${fulfilled.length}`, agreement: 'majority', n: fulfilled.length, totalMs,
    };
  }
  // Empate exacto (par de judges): conservative defaults a ejecutar
  return {
    action: 'execute',
    reason: 'tie_conservative_execute', agreement: 'split', n: fulfilled.length, totalMs,
  };
}

module.exports = {
  buildEnsembleJudge,
  fuseVerdicts,
  raceAll,
  DEFAULT_BUDGET_MS,
};
