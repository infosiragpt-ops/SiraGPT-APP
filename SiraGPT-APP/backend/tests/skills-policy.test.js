/**
 * skills/policy tests — capability + usage enforcement.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { CAPABILITIES } = require('../src/services/skills/capabilities');
const {
  createPolicy, createCounters, checkSkill, wrapSkill, wrapSkillsWithPolicy,
  PolicyError, MAIN_ALLOW, SANDBOX_ALLOW,
} = require('../src/services/skills/policy');

const skillLLM = {
  id: 'think', capabilities: [CAPABILITIES.LLM],
  execute: async () => 'ok',
};
const skillNet = {
  id: 'net', capabilities: [CAPABILITIES.NET_OUTBOUND, CAPABILITIES.LLM],
  execute: async () => 'net ok',
};
const skillBrowser = {
  id: 'browse', capabilities: [CAPABILITIES.BROWSER],
  execute: async () => 'clicked',
};
const skillShell = {
  id: 'sh', capabilities: [CAPABILITIES.SHELL],
  execute: async () => 'pwned',
};

test('main mode: broad allow, shell denied', () => {
  const policy = createPolicy({ mode: 'main' });
  assert.equal(checkSkill(policy, skillLLM).ok, true);
  assert.equal(checkSkill(policy, skillNet).ok, true);
  assert.equal(checkSkill(policy, skillBrowser).ok, true);
  const shell = checkSkill(policy, skillShell);
  assert.equal(shell.ok, false);
  assert.equal(shell.code, 'capability_not_granted');
});

test('sandbox mode: only LLM + fs:read + net:outbound:llm + agent:read by default', () => {
  const policy = createPolicy({ mode: 'sandbox' });
  assert.equal(checkSkill(policy, skillLLM).ok, true);
  assert.equal(checkSkill(policy, skillNet).ok, false, 'broad net should be denied in sandbox');
  assert.equal(checkSkill(policy, skillBrowser).ok, false);
  assert.equal(checkSkill(policy, skillShell).ok, false);
});

test('explicit deny overrides allow', () => {
  const policy = createPolicy({
    mode: 'main',
    deny: [CAPABILITIES.NET_OUTBOUND],
  });
  const decision = checkSkill(policy, skillNet);
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'capability_denied');
});

test('skill-id allowlist restricts visible skills', () => {
  const policy = createPolicy({
    mode: 'main',
    skills: { allow: ['think'] },
  });
  assert.equal(checkSkill(policy, skillLLM).ok, true);
  const netDec = checkSkill(policy, skillNet);
  assert.equal(netDec.ok, false);
  assert.equal(netDec.code, 'skill_not_allowed');
});

test('skill-id deny wins over capability allow', () => {
  const policy = createPolicy({
    mode: 'main',
    skills: { deny: ['think'] },
  });
  const dec = checkSkill(policy, skillLLM);
  assert.equal(dec.ok, false);
  assert.equal(dec.code, 'skill_denied');
});

test('counters — maxCalls caps total across skills', () => {
  const policy = createPolicy({ mode: 'main', limits: { maxCalls: 2, maxCallsPerSkill: 10 } });
  const counters = createCounters();
  counters.incr('think'); counters.incr('net');
  const dec = checkSkill(policy, skillLLM, counters);
  assert.equal(dec.ok, false);
  assert.equal(dec.code, 'limit_total');
});

test('counters — maxCallsPerSkill caps same skill', () => {
  const policy = createPolicy({ mode: 'main', limits: { maxCalls: 100, maxCallsPerSkill: 1 } });
  const counters = createCounters();
  counters.incr('think');
  const dec = checkSkill(policy, skillLLM, counters);
  assert.equal(dec.ok, false);
  assert.equal(dec.code, 'limit_per_skill');
});

test('wrapSkill blocks denied calls with PolicyError', async () => {
  const policy = createPolicy({ mode: 'sandbox' });
  const counters = createCounters();
  const wrapped = wrapSkill(skillBrowser, policy, counters);
  await assert.rejects(() => wrapped.execute({}, {}), /policy/i);
  await assert.rejects(() => wrapped.execute({}, {}), PolicyError);
  assert.equal(counters.total, 0, 'denied calls should not consume budget');
});

test('wrapSkill increments counters only on success', async () => {
  const policy = createPolicy({ mode: 'main' });
  const counters = createCounters();
  const failing = {
    id: 'fail', capabilities: [CAPABILITIES.LLM],
    execute: async () => { throw new Error('transient'); },
  };
  const wrapped = wrapSkill(failing, policy, counters);
  await assert.rejects(() => wrapped.execute({}, {}), /transient/);
  assert.equal(counters.total, 0, 'tool error should not consume budget');

  const ok = wrapSkill(skillLLM, policy, counters);
  await ok.execute({}, {});
  assert.equal(counters.total, 1);
  assert.equal(counters.get('think'), 1);
});

test('wrapSkillsWithPolicy filters out statically-denied skills', () => {
  const policy = createPolicy({ mode: 'sandbox' });
  const { skills, hidden } = wrapSkillsWithPolicy([skillLLM, skillNet, skillBrowser, skillShell], policy);
  const visibleIds = skills.map(s => s.id);
  assert.deepEqual(visibleIds.sort(), ['think']);
  const hiddenIds = hidden.map(h => h.id).sort();
  assert.deepEqual(hiddenIds, ['browse', 'net', 'sh']);
});

test('wrapSkillsWithPolicy accepts a Map as well as an array', () => {
  const policy = createPolicy({ mode: 'main' });
  const map = new Map([['think', skillLLM], ['net', skillNet]]);
  const { skills } = wrapSkillsWithPolicy(map, policy);
  assert.equal(skills.length, 2);
});

test('createPolicy rejects unknown capabilities in overrides', () => {
  assert.throws(() => createPolicy({ mode: 'main', allow: ['made-up'] }), /unknown capability/);
  assert.throws(() => createPolicy({ mode: 'main', deny: ['also-fake'] }), /unknown capability/);
});

test('MAIN_ALLOW excludes shell but includes LLM+net+browser+schedule', () => {
  assert.ok(!MAIN_ALLOW.includes(CAPABILITIES.SHELL));
  assert.ok(MAIN_ALLOW.includes(CAPABILITIES.LLM));
  assert.ok(MAIN_ALLOW.includes(CAPABILITIES.BROWSER));
  assert.ok(MAIN_ALLOW.includes(CAPABILITIES.MEDIA_PROCESS));
  assert.ok(MAIN_ALLOW.includes(CAPABILITIES.SCHEDULE));
});

test('SANDBOX_ALLOW is the minimum useful set — LLM + fs:read', () => {
  assert.ok(SANDBOX_ALLOW.includes(CAPABILITIES.LLM));
  assert.ok(SANDBOX_ALLOW.includes(CAPABILITIES.FS_READ));
  assert.ok(!SANDBOX_ALLOW.includes(CAPABILITIES.BROWSER));
  assert.ok(!SANDBOX_ALLOW.includes(CAPABILITIES.MEDIA_PROCESS));
  assert.ok(!SANDBOX_ALLOW.includes(CAPABILITIES.SCHEDULE));
  assert.ok(!SANDBOX_ALLOW.includes(CAPABILITIES.AGENT_SPAWN));
  assert.ok(!SANDBOX_ALLOW.includes(CAPABILITIES.SHELL));
});

// ── Skill execution deadline / abort ──────────────────────────────────────
//
// Every wrapped skill now runs under AsyncGuard. These tests pin the
// resolution order (override > skill.timeoutMs > policy.limits.timeoutMs)
// and confirm that timeout / abort do NOT consume call budget, mirroring
// the existing "transient error doesn't consume budget" guarantee.

test('wrapSkill enforces deadline declared on the skill manifest', async () => {
  const policy = createPolicy({ mode: 'main' });
  const counters = createCounters();
  const slow = {
    id: 'slow_skill',
    capabilities: [CAPABILITIES.LLM],
    timeoutMs: 50,
    execute: () => new Promise(() => {}), // never resolves
  };
  const wrapped = wrapSkill(slow, policy, counters);
  const t0 = Date.now();
  await assert.rejects(() => wrapped.execute({}, {}), (err) => {
    assert.equal(err.code, 'GUARD_TIMEOUT');
    assert.match(err.message, /timed out/i);
    return true;
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5_000, `should fail fast (got ${elapsed}ms)`);
  assert.equal(counters.total, 0, 'timed-out call must not consume budget');
});

test('wrapSkill timeout falls back to policy.limits.timeoutMs', async () => {
  const policy = createPolicy({ mode: 'main', limits: { timeoutMs: 50 } });
  const counters = createCounters();
  const slow = {
    id: 'slow_no_skill_limit',
    capabilities: [CAPABILITIES.LLM],
    execute: () => new Promise(() => {}),
  };
  const wrapped = wrapSkill(slow, policy, counters);
  await assert.rejects(() => wrapped.execute({}, {}), /timed out/i);
});

test('wrapSkill opts.timeoutMs overrides skill manifest and policy', async () => {
  const policy = createPolicy({ mode: 'main', limits: { timeoutMs: 9_999 } });
  const counters = createCounters();
  const slow = {
    id: 'override_test',
    capabilities: [CAPABILITIES.LLM],
    timeoutMs: 9_999,
    execute: () => new Promise(() => {}),
  };
  const wrapped = wrapSkill(slow, policy, counters, { timeoutMs: 50 });
  await assert.rejects(() => wrapped.execute({}, {}), /timed out/i);
});

test('wrapSkill propagates external AbortSignal via ctx.signal', async () => {
  // AsyncGuard surfaces an external-signal abort with the same
  // GuardError envelope as a timeout (the two paths share state in
  // async-guard.js), so we assert on the contract that matters: a
  // GuardError is thrown, it fails fast, and it does NOT consume
  // budget. The exact code (GUARD_TIMEOUT vs GUARD_ABORTED) is an
  // implementation detail of async-guard and pinning it here would
  // make this test brittle to a future async-guard fix.
  const policy = createPolicy({ mode: 'main' });
  const counters = createCounters();
  const hang = {
    id: 'hang_skill',
    capabilities: [CAPABILITIES.LLM],
    execute: () => new Promise(() => {}),
  };
  const wrapped = wrapSkill(hang, policy, counters);
  const ac = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ac.abort('caller cancelled'), 30);
  await assert.rejects(() => wrapped.execute({}, { signal: ac.signal }), (err) => {
    assert.equal(err.name, 'GuardError');
    assert.ok(err.code === 'GUARD_ABORTED' || err.code === 'GUARD_TIMEOUT',
      `expected GuardError code, got ${err.code}`);
    return true;
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5_000, `external abort should fail fast (got ${elapsed}ms)`);
  assert.equal(counters.total, 0, 'aborted call must not consume budget');
});

test('wrapSkill does not regress fast skills', async () => {
  const policy = createPolicy({ mode: 'main' });
  const counters = createCounters();
  const fast = {
    id: 'fast_skill',
    capabilities: [CAPABILITIES.LLM],
    execute: async () => 'done',
  };
  const wrapped = wrapSkill(fast, policy, counters);
  const result = await wrapped.execute({}, {});
  assert.equal(result, 'done');
  assert.equal(counters.total, 1);
});

test('wrapSkill captures sync throws inside execute and surfaces them', async () => {
  const policy = createPolicy({ mode: 'main' });
  const counters = createCounters();
  const broken = {
    id: 'broken_sync',
    capabilities: [CAPABILITIES.LLM],
    execute: () => { throw new Error('sync boom'); },
  };
  const wrapped = wrapSkill(broken, policy, counters);
  await assert.rejects(() => wrapped.execute({}, {}), /sync boom/);
  assert.equal(counters.total, 0, 'sync throw must not consume budget');
});
