/**
 * Tests for services/skills/index.js — barrel exports + lazy
 * registry cache.
 *
 * We inject mocks for ./registry and ./policy via require cache so
 * the lazy load doesn't actually scan the filesystem.
 */

'use strict';

const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');
const { describe, it, before, beforeEach, after } = require('node:test');

const REG_PATH = require.resolve('../src/services/skills/registry');
const POL_PATH = require.resolve('../src/services/skills/policy');
const CAP_PATH = require.resolve('../src/services/skills/capabilities');
const IDX_PATH = require.resolve('../src/services/skills');

let lastLoadOpts = null;
let nextLoadResult = { skills: new Map(), errors: [] };

const registryMock = {
  load: (opts) => { lastLoadOpts = opts; return nextLoadResult; },
  toReactTool: 'fn:toReactTool',
  toAgentCoreTool: 'fn:toAgentCoreTool',
  filterByCapabilities: 'fn:filterByCapabilities',
  listSkills: 'fn:listSkills',
};

const policyMock = {
  createPolicy: 'fn:createPolicy',
  wrapSkillsWithPolicy: 'fn:wrapSkillsWithPolicy',
  PolicyError: class PolicyError extends Error {},
};

let origReg, origPol, origIdx;

function installMocks() {
  origReg = require.cache[REG_PATH];
  origPol = require.cache[POL_PATH];
  origIdx = require.cache[IDX_PATH];
  function entry(id, exports_) {
    const m = new Module(id);
    m.filename = id;
    m.loaded = true;
    m.exports = exports_;
    m.paths = Module._nodeModulePaths(path.dirname(id));
    return m;
  }
  require.cache[REG_PATH] = entry(REG_PATH, registryMock);
  require.cache[POL_PATH] = entry(POL_PATH, policyMock);
  delete require.cache[IDX_PATH];
}

function restoreMocks() {
  if (origReg) require.cache[REG_PATH] = origReg; else delete require.cache[REG_PATH];
  if (origPol) require.cache[POL_PATH] = origPol; else delete require.cache[POL_PATH];
  if (origIdx) require.cache[IDX_PATH] = origIdx; else delete require.cache[IDX_PATH];
}

const _origWarn = console.warn;
function muteWarn() { console.warn = () => {}; }
function restoreWarn() { console.warn = _origWarn; }

let skills;

before(() => {
  installMocks();
  skills = require('../src/services/skills');
});

after(() => {
  restoreMocks();
});

beforeEach(() => {
  lastLoadOpts = null;
  nextLoadResult = { skills: new Map(), errors: [] };
  // Each test starts with a clean cache.
  if (skills._reset_for_tests) skills._reset_for_tests();
  delete require.cache[IDX_PATH];
  skills = require('../src/services/skills');
});

// ── lazy get() cache ─────────────────────────────────────────────

describe('skills.get · lazy cache', () => {
  it('first call invokes registry.load and returns the result', () => {
    const out = skills.get();
    assert.strictEqual(out, nextLoadResult);
  });

  it('second call returns the SAME object (no re-scan)', () => {
    const a = skills.get();
    // Even if we change what registry.load *would* return, the cached
    // result is still served — proving the lazy cache.
    nextLoadResult = { skills: new Map([['x', {}]]), errors: [] };
    const b = skills.get();
    assert.strictEqual(a, b);
  });

  it('warns once with each error when load returns errors', () => {
    const warns = [];
    console.warn = (msg) => warns.push(msg);
    nextLoadResult = {
      skills: new Map(),
      errors: ['bad-skill: broken manifest', 'other-skill: typo'],
    };
    try {
      skills.get();
    } finally {
      restoreWarn();
    }
    // 1 banner line + 2 per-error lines
    assert.ok(warns.some((w) => /loaded with 2 error\(s\)/.test(w)));
    assert.ok(warns.some((w) => w.includes('bad-skill')));
    assert.ok(warns.some((w) => w.includes('other-skill')));
  });
});

// ── reload ───────────────────────────────────────────────────────

describe('skills.reload', () => {
  it('always invokes registry.load (no cache)', () => {
    skills.get();  // populate
    nextLoadResult = { skills: new Map([['fresh', {}]]), errors: [] };
    const out = skills.reload();
    assert.strictEqual(out, nextLoadResult);
  });

  it('passes opts through to registry.load', () => {
    skills.reload({ fresh: true });
    assert.deepEqual(lastLoadOpts, { fresh: true });
  });

  it('coerces missing opts to {}', () => {
    skills.reload();
    assert.deepEqual(lastLoadOpts, {});
  });

  it('updates the lazy cache (subsequent get returns the reloaded result)', () => {
    skills.get();  // populate cache with initial empty Map
    nextLoadResult = { skills: new Map([['post-reload', {}]]), errors: [] };
    skills.reload();
    const after = skills.get();
    assert.ok(after.skills.has('post-reload'));
  });
});

// ── barrel re-exports ────────────────────────────────────────────

describe('skills · barrel re-exports', () => {
  it('exposes registry and policy modules directly', () => {
    assert.strictEqual(skills.registry, registryMock);
    assert.strictEqual(skills.policy, policyMock);
  });

  it('re-exports CAPABILITIES from ./capabilities', () => {
    const realCaps = require('../src/services/skills/capabilities');
    assert.strictEqual(skills.CAPABILITIES, realCaps.CAPABILITIES);
  });

  it('re-exports the registry convenience helpers', () => {
    assert.strictEqual(skills.toReactTool, 'fn:toReactTool');
    assert.strictEqual(skills.toAgentCoreTool, 'fn:toAgentCoreTool');
    assert.strictEqual(skills.filterByCapabilities, 'fn:filterByCapabilities');
    assert.strictEqual(skills.listSkills, 'fn:listSkills');
  });

  it('re-exports the policy convenience helpers', () => {
    assert.strictEqual(skills.createPolicy, 'fn:createPolicy');
    assert.strictEqual(skills.wrapSkillsWithPolicy, 'fn:wrapSkillsWithPolicy');
    assert.strictEqual(skills.PolicyError, policyMock.PolicyError);
  });
});
