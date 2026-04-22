/**
 * skills/policy — per-session capability + usage enforcement.
 *
 * The registry (registry.js) tells us what a skill CAN do. Policy tells
 * us what the session IS ALLOWED to do. A skill invocation is only
 * permitted if its required capabilities are all granted AND the
 * per-call/per-skill usage budget has not been exhausted.
 *
 * This is the openclaw "main vs non-main" sandbox idea adapted: the
 * `main` session (authenticated human user at their own UI) gets broad
 * access by default, while sub-sessions spawned by agent:spawn or
 * triggered by schedules get the tighter `sandbox` defaults.
 *
 * Two entry points:
 *   createPolicy(opts)    — build a Policy object from overrides.
 *   wrapSkillsWithPolicy(skills, policy) — decorate skills so every
 *                                          execute() goes through the
 *                                          policy check first.
 *
 * Denied invocations throw a PolicyError, which react-agent /
 * agent-core catch as a normal tool error and surface to the LLM as an
 * observation ("you are not allowed to call X because Y"). That's the
 * right UX: the model can adapt instead of crashing the run.
 */

const { CAPABILITIES, ALL_CAPABILITIES, isKnown } = require('./capabilities');

class PolicyError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PolicyError';
    this.code = code || 'policy_denied';
  }
}

// ─── Defaults ──────────────────────────────────────────────────────────────
//
// `main` is what a logged-in user gets at their own UI — broad access,
// only shell is blocked unconditionally. Adding a new capability
// automatically flows into `main` (it's the complement of the denylist).
//
// `sandbox` is what sub-agents / scheduled runs / shared-chat sessions
// get — the narrowest set that still lets the agent reason and read
// the user's own collection. Anything riskier (browser, schedule,
// fs:write, agent:spawn, shell) must be explicitly granted.

const MAIN_DENY = [CAPABILITIES.SHELL];
const MAIN_ALLOW = ALL_CAPABILITIES.filter(c => !MAIN_DENY.includes(c));

const SANDBOX_ALLOW = [
  CAPABILITIES.LLM,
  CAPABILITIES.NET_LLM,
  CAPABILITIES.FS_READ,
  CAPABILITIES.AGENT_READ,
];

const DEFAULT_LIMITS = Object.freeze({
  maxCalls: 50,         // total skill invocations per session
  maxCallsPerSkill: 20, // per-skill cap to prevent loops on one tool
});

const SANDBOX_LIMITS = Object.freeze({
  maxCalls: 20,
  maxCallsPerSkill: 8,
});

// ─── Policy construction ──────────────────────────────────────────────────

/**
 * Build a Policy object.
 *
 * @param {object} [opts]
 * @param {'main'|'sandbox'} [opts.mode='main']
 * @param {string[]} [opts.allow] — override the mode's allow list
 * @param {string[]} [opts.deny]  — capabilities to strip, overrides allow
 * @param {object} [opts.skills]  — { allow?: string[], deny?: string[] }
 *                                  skill-id level filters
 * @param {object} [opts.limits]  — { maxCalls, maxCallsPerSkill } overrides
 *
 * @returns {Policy}
 */
function createPolicy(opts = {}) {
  const mode = opts.mode || 'main';
  const baseAllow = mode === 'sandbox' ? SANDBOX_ALLOW : MAIN_ALLOW;
  const baseLimits = mode === 'sandbox' ? SANDBOX_LIMITS : DEFAULT_LIMITS;

  const allowSet = new Set(opts.allow || baseAllow);
  const denySet = new Set(opts.deny || []);
  for (const c of allowSet) {
    if (!isKnown(c)) throw new Error(`policy allow: unknown capability "${c}"`);
  }
  for (const c of denySet) {
    if (!isKnown(c)) throw new Error(`policy deny: unknown capability "${c}"`);
  }

  const skillAllow = opts.skills?.allow ? new Set(opts.skills.allow) : null;
  const skillDeny = new Set(opts.skills?.deny || []);

  const limits = { ...baseLimits, ...(opts.limits || {}) };

  return {
    mode,
    allow: allowSet,
    deny: denySet,
    skillAllow,
    skillDeny,
    limits,
  };
}

// ─── Runtime counters ─────────────────────────────────────────────────────
//
// A Counters object tracks how many times each skill has been called
// in this session. Fresh per run — the counters are not persisted
// across requests, since a run's budget shouldn't carry over.

function createCounters() {
  return {
    total: 0,
    perSkill: new Map(),
    incr(skillId) {
      this.total++;
      this.perSkill.set(skillId, (this.perSkill.get(skillId) || 0) + 1);
    },
    get(skillId) {
      return this.perSkill.get(skillId) || 0;
    },
  };
}

// ─── Check / wrap ─────────────────────────────────────────────────────────

/**
 * Decide whether a skill invocation should proceed. Pure function —
 * does not mutate counters (that's the caller's job after success, so
 * denied calls don't consume budget).
 *
 * @returns {{ ok: true } | { ok: false, reason: string, code: string }}
 */
function checkSkill(policy, skill, counters) {
  if (policy.skillDeny.has(skill.id)) {
    return { ok: false, reason: `skill "${skill.id}" is denied by session policy`, code: 'skill_denied' };
  }
  if (policy.skillAllow && !policy.skillAllow.has(skill.id)) {
    return { ok: false, reason: `skill "${skill.id}" is not in the session's allow list`, code: 'skill_not_allowed' };
  }
  for (const cap of skill.capabilities) {
    if (policy.deny.has(cap)) {
      return { ok: false, reason: `capability "${cap}" required by ${skill.id} is denied`, code: 'capability_denied' };
    }
    if (!policy.allow.has(cap)) {
      return { ok: false, reason: `capability "${cap}" required by ${skill.id} is not granted`, code: 'capability_not_granted' };
    }
  }
  if (counters) {
    if (counters.total >= policy.limits.maxCalls) {
      return { ok: false, reason: `session has hit maxCalls=${policy.limits.maxCalls}`, code: 'limit_total' };
    }
    if (counters.get(skill.id) >= policy.limits.maxCallsPerSkill) {
      return { ok: false, reason: `skill "${skill.id}" hit maxCallsPerSkill=${policy.limits.maxCallsPerSkill}`, code: 'limit_per_skill' };
    }
  }
  return { ok: true };
}

/**
 * Return a new skill whose execute() enforces `policy`. The wrapper
 * increments counters on success so a failing tool doesn't consume
 * budget — an important behaviour for robustness: a transient RAG
 * outage should not also exhaust the session's call limit.
 *
 * Errors thrown from inside execute() are re-thrown — react-agent and
 * agent-core turn them into observations. A denied call raises
 * PolicyError; the loop sees the error string and can adapt.
 */
function wrapSkill(skill, policy, counters) {
  const userExecute = skill.execute;
  return {
    ...skill,
    async execute(args, ctx) {
      const decision = checkSkill(policy, skill, counters);
      if (!decision.ok) {
        throw new PolicyError(decision.reason, decision.code);
      }
      const result = await userExecute(args, ctx);
      counters.incr(skill.id);
      return result;
    },
  };
}

/**
 * Bulk-wrap a set of skills (Map or array) against a policy. Also
 * filters out skills that are unconditionally denied by the policy —
 * there's no point advertising them to the LLM if it can never call
 * them successfully. This prevents the agent from wasting its step
 * budget calling a tool it'll be denied on every turn.
 *
 * The filter only removes skills denied by capability/allow-list
 * reasons. Limit-based denials (which are dynamic) still surface as
 * PolicyError at call time.
 */
function wrapSkillsWithPolicy(skills, policy) {
  const counters = createCounters();
  const input = skills instanceof Map ? Array.from(skills.values()) : skills;
  const visible = [];
  const hidden = [];

  for (const skill of input) {
    // Use a dummy counters object (no limits consumed) so we only
    // detect static denials — capability and skill-list based.
    const staticDecision = checkSkill(policy, skill, null);
    if (!staticDecision.ok) {
      hidden.push({ id: skill.id, reason: staticDecision.reason });
      continue;
    }
    visible.push(wrapSkill(skill, policy, counters));
  }

  return { skills: visible, hidden, counters };
}

module.exports = {
  createPolicy,
  createCounters,
  checkSkill,
  wrapSkill,
  wrapSkillsWithPolicy,
  PolicyError,
  DEFAULT_LIMITS,
  SANDBOX_LIMITS,
  MAIN_ALLOW,
  SANDBOX_ALLOW,
};
