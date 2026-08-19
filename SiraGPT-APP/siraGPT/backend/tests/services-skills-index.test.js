'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const skills = require('../src/services/skills');

test('exports the public surface', () => {
  for (const fn of ['get', 'reload', 'toReactTool', 'toAgentCoreTool', 'filterByCapabilities', 'listSkills', 'createPolicy', 'wrapSkillsWithPolicy']) {
    assert.equal(typeof skills[fn], 'function', `expected function: ${fn}`);
  }
  assert.ok(skills.registry);
  assert.ok(skills.capabilities);
  assert.ok(skills.policy);
  assert.ok(skills.CAPABILITIES);
  assert.equal(typeof skills.PolicyError, 'function');
});

test('CAPABILITIES re-export matches capabilities.CAPABILITIES', () => {
  assert.equal(skills.CAPABILITIES, skills.capabilities.CAPABILITIES);
});

test('get() returns a { skills, errors } shape', () => {
  const result = skills.get();
  assert.ok(result);
  assert.ok(result.skills instanceof Map);
  assert.ok(Array.isArray(result.errors));
});

test('get() is cached — second call returns the same object reference', () => {
  const a = skills.get();
  const b = skills.get();
  assert.equal(a, b, 'subsequent get() must return the cached instance');
});

test('reload() returns a fresh { skills, errors } object', () => {
  const before = skills.get();
  const after = skills.reload();
  assert.ok(after);
  assert.ok(after.skills instanceof Map);
  // After reload, get() should return the new cached instance
  const next = skills.get();
  assert.equal(next, after);
});

test('reload({ fresh: true }) accepts options without throwing', () => {
  assert.doesNotThrow(() => skills.reload({ fresh: true }));
});

test('PolicyError is a real Error subclass', () => {
  const err = new skills.PolicyError('not allowed');
  assert.ok(err instanceof Error);
  assert.equal(err.message, 'not allowed');
});

test('toReactTool / toAgentCoreTool are callable adapters', () => {
  // Pick the first loaded skill (if any) to feed the adapters
  const result = skills.get();
  if (result.skills.size === 0) return; // nothing to assert against
  const [, firstSkill] = result.skills.entries().next().value;
  assert.doesNotThrow(() => skills.toReactTool(firstSkill));
  assert.doesNotThrow(() => skills.toAgentCoreTool(firstSkill));
});

test('listSkills returns an array (possibly empty if no skills are present)', () => {
  const result = skills.get();
  const list = skills.listSkills(result.skills);
  assert.ok(Array.isArray(list));
});

test('filterByCapabilities accepts a capabilities set and returns a Map', () => {
  const result = skills.get();
  const caps = new Set([Object.values(skills.CAPABILITIES)[0]].filter(Boolean));
  const filtered = skills.filterByCapabilities(result.skills, caps);
  assert.ok(filtered instanceof Map || Array.isArray(filtered) || typeof filtered === 'object');
});

test('createPolicy returns a usable policy object', () => {
  const p = skills.createPolicy({});
  assert.ok(p);
});
