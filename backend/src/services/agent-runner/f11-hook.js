'use strict';

/**
 * F11 glue: merge Hermes-style skill_manage + cron tools into F8 extras,
 * and author a skill after a verified / complex turn.
 * Safe if F8 or F11 modules are missing.
 */

function tryRequire(id) {
  try { return require(id); } catch { return null; }
}

function mergeToolDefs(a, b) {
  const out = [];
  const seen = new Set();
  for (const list of [a, b]) {
    for (const def of list || []) {
      const name = def && def.function && def.function.name;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(def);
    }
  }
  return out;
}

function mergeF11Extras(base = {}, { env = process.env, userId } = {}) {
  const manage = tryRequire('./skills/manage');
  const cron = tryRequire('../agent-cron');
  const extraDefs = [];
  const extraExec = {};
  if (manage) {
    if (typeof manage.extraToolDefinitions === 'function') {
      extraDefs.push(...(manage.extraToolDefinitions({ env, userId }) || []));
    }
    if (typeof manage.extraExecutors === 'function') {
      Object.assign(extraExec, manage.extraExecutors({ env, userId }) || {});
    }
  }
  if (cron && typeof cron.extraToolDefinitions === 'function') {
    extraDefs.push(...(cron.extraToolDefinitions({ env }) || []));
  }
  if (cron && typeof cron.extraExecutors === 'function') {
    Object.assign(extraExec, cron.extraExecutors({ env }) || {});
  }
  return {
    extraToolDefinitions: mergeToolDefs(base.extraToolDefinitions, extraDefs),
    extraExecutors: { ...(base.extraExecutors || {}), ...extraExec },
  };
}

async function afterTurnLearn(turn = {}, { env = process.env } = {}) {
  const manage = tryRequire('./skills/manage');
  if (!manage || typeof manage.maybeAuthorSkill !== 'function') {
    return { created: false, reason: 'no_manage' };
  }
  try {
    return await manage.maybeAuthorSkill({
      userId: turn.userId,
      instruction: turn.instruction || turn.message || '',
      outcome: turn.summary || turn.finalText || '',
      toolCallCount: Number(turn.toolCallCount) || 0,
      verified: Boolean(turn.verified || (turn.validation && turn.validation.passed)),
      skillsHome: env.SIRAGPT_AGENT_SKILLS_HOME,
    });
  } catch (err) {
    return { created: false, reason: err.message };
  }
}

module.exports = { mergeF11Extras, afterTurnLearn };
