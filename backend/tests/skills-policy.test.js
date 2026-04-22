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
  assert.ok(MAIN_ALLOW.includes(CAPABILITIES.SCHEDULE));
});

test('SANDBOX_ALLOW is the minimum useful set — LLM + fs:read', () => {
  assert.ok(SANDBOX_ALLOW.includes(CAPABILITIES.LLM));
  assert.ok(SANDBOX_ALLOW.includes(CAPABILITIES.FS_READ));
  assert.ok(!SANDBOX_ALLOW.includes(CAPABILITIES.BROWSER));
  assert.ok(!SANDBOX_ALLOW.includes(CAPABILITIES.SCHEDULE));
  assert.ok(!SANDBOX_ALLOW.includes(CAPABILITIES.AGENT_SPAWN));
  assert.ok(!SANDBOX_ALLOW.includes(CAPABILITIES.SHELL));
});
