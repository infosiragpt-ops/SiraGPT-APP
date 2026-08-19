'use strict';

/**
 * autonomous-goal-escalation
 *
 * Detects natural-language requests that should keep working in the
 * background even if the user opens another chat. This complements the
 * explicit `/goal` command: users often say "trabaja por meses",
 * "sin detenerse", "investiga y verifica", or paste a thesis/research
 * spec without using a slash command.
 *
 * The module is deliberately split in two layers:
 *   - buildAutonomousGoalEscalation: pure deterministic policy, easy to test.
 *   - maybeCreateAutonomousGoalRun: best-effort persistence + queue bridge.
 */

const goalEvents = require('./goal-events');
const goalQueue = require('./goal-queue');

const LONG_RUNNING_RE = /\b(?:meses?|semanas?|d[ií]as?|horas?|sin\s+detenerse|sin\s+parar|no\s+pares?|background|segundo\s+plano|aunque\s+(?:cierre|salga)|persistente|durable|auto.?ejecut|contin[uú]a(?:r)?|long.?running)\b/i;
const RESEARCH_RE = /\b(?:investiga|investigaci[oó]n|tesis|art[ií]culos?\s+cient[ií]ficos?|doi|scopus|scite|apa\s*7|referencias?|bibliograf[ií]a|metodolog[ií]a|resultados?|discusi[oó]n|conclusiones?|marco\s+te[oó]rico|realidad\s+problem[aá]tica)\b/i;
const VERIFY_RE = /\b(?:verifica|validar|validaci[oó]n|fuentes?\s+reales?|real\s+verificable|no\s+inventes?|citas?\s+reales?|referencias?\s+correctas?|estatus\s+verde|ci\s+verde|green\s+status)\b/i;
const MULTI_AGENT_RE = /\b(?:agentes?|miles\s+de\s+tareas|muchos\s+hilos|aut[oó]nom[oa]s?|controlar\s+cualquier\s+cosa|planificar|organizar|dirigir|ejecutar|controlar)\b/i;
const CODE_RE = /\b(?:github|repo(?:sitorio)?|commit|push|pull\s+request|merge|deploy|claude\s+code|codex|cursor|npm\s+test|eslint|refactor|programa|c[oó]digo|frontend|backend)\b/i;

const DEFAULT_MIN_SCORE = 4;

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function inferDepth(score, text) {
  if (score >= 8 || /\b(?:meses?|semanas?|tesis|scopus|scite|art[ií]culos?\s+cient[ií]ficos?)\b/i.test(text)) return 'deep';
  if (score >= 5) return 'standard';
  return 'quick';
}

function buildAutonomousGoalEscalation({
  prompt = '',
  history = [],
  codeIntent = null,
  minScore = DEFAULT_MIN_SCORE,
} = {}) {
  const current = normalizeText(prompt);
  if (!current) {
    return { shouldEscalate: false, score: 0, reasons: ['empty_prompt'], depth: 'quick', agentKind: 'research' };
  }

  const historyText = Array.isArray(history)
    ? history.slice(-8).map((m) => normalizeText(m?.content || m?.text || '')).filter(Boolean).join(' ')
    : '';
  const text = `${historyText} ${current}`.trim();
  const reasons = [];
  let score = 0;

  if (LONG_RUNNING_RE.test(text)) { score += 3; reasons.push('long_running_language'); }
  if (RESEARCH_RE.test(text)) { score += 2; reasons.push('research_or_thesis_scope'); }
  if (VERIFY_RE.test(text)) { score += 2; reasons.push('verification_required'); }
  if (MULTI_AGENT_RE.test(text)) { score += 1; reasons.push('autonomous_multi_agent_scope'); }

  const isCodeTask = Boolean(codeIntent?.isCodeTask) || CODE_RE.test(current);
  if (isCodeTask) {
    reasons.push('code_task_prefers_codex');
    // Code/repo work already has a Codex delegation path. Do not create
    // a research goal for it unless there is also clear long-running
    // research/thesis scope.
    if (!RESEARCH_RE.test(text) && !LONG_RUNNING_RE.test(text)) {
      return {
        shouldEscalate: false,
        score,
        reasons,
        depth: 'quick',
        agentKind: 'codex',
      };
    }
  }

  const depth = inferDepth(score, text);
  return {
    shouldEscalate: score >= Math.max(1, Number(minScore) || DEFAULT_MIN_SCORE),
    score,
    reasons,
    depth,
    agentKind: isCodeTask ? 'research-codex-support' : 'research',
  };
}

async function maybeCreateAutonomousGoalRun({
  prisma,
  userId,
  chatId = null,
  prompt,
  history = [],
  codeIntent = null,
  minScore,
} = {}) {
  const decision = buildAutonomousGoalEscalation({ prompt, history, codeIntent, minScore });
  if (!decision.shouldEscalate) return { ok: false, created: false, decision };
  if (!prisma || !prisma.goalRun) return { ok: false, created: false, reason: 'persistence_unavailable', decision };
  if (!userId) return { ok: false, created: false, reason: 'missing_user', decision };

  try {
    const created = await prisma.goalRun.create({
      data: {
        userId: String(userId),
        chatId: chatId ? String(chatId) : null,
        status: 'queued',
        prompt: normalizeText(prompt),
        depth: decision.depth,
        agentKind: decision.agentKind,
      },
    });

    await goalEvents.appendEvent({
      goalRunId: created.id,
      type: 'info',
      payload: {
        type: 'info',
        message: 'auto_queued_from_chat',
        score: decision.score,
        reasons: decision.reasons,
        depth: decision.depth,
        agentKind: decision.agentKind,
        at: new Date().toISOString(),
      },
    });

    let enqueueWarning = null;
    try {
      await goalQueue.enqueueGoalRun({ goalRunId: created.id });
    } catch (err) {
      enqueueWarning = err?.message || 'enqueue_failed';
    }

    return {
      ok: true,
      created: true,
      goalRunId: created.id,
      status: created.status,
      depth: created.depth,
      agentKind: created.agentKind,
      enqueueWarning,
      decision,
    };
  } catch (err) {
    return {
      ok: false,
      created: false,
      reason: 'create_failed',
      error: err?.message || String(err),
      decision,
    };
  }
}

module.exports = {
  buildAutonomousGoalEscalation,
  maybeCreateAutonomousGoalRun,
  _internal: {
    CODE_RE,
    LONG_RUNNING_RE,
    MULTI_AGENT_RE,
    RESEARCH_RE,
    VERIFY_RE,
    inferDepth,
  },
};
