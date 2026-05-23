/**
 * Tests for services/searchBrain/index.js — public entrypoint that
 * wires deps and projects results for the chat surface.
 *
 * We stub ./orchestrator (runSearchBrain) and ./chatAdapter
 * (projectForChat) so the test stays focused on the wiring contract.
 */

'use strict';

const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');
const { describe, it, before, after, beforeEach } = require('node:test');

const ORCH_PATH = require.resolve('../src/services/searchBrain/orchestrator');
const CHAT_PATH = require.resolve('../src/services/searchBrain/chatAdapter');
const PROV_PATH = require.resolve('../src/services/searchBrain/providers');
const LLM_PATH = require.resolve('../src/services/searchBrain/llmClient');
const IDX_PATH = require.resolve('../src/services/searchBrain');

let lastRunOpts = null;
let nextRunResult = { results: [], cohort: 'mixed' };
let lastProjectArg = null;
let nextProjectResult = { citations: [], promptInjection: '', providersUsed: [] };

const orchestratorMock = {
  runSearchBrain: async (opts) => {
    lastRunOpts = opts;
    return nextRunResult;
  },
};

const chatAdapterMock = {
  projectForChat: (resp) => {
    lastProjectArg = resp;
    return nextProjectResult;
  },
  toCitation: 'fn:toCitation',
  buildPromptInjection: 'fn:buildPromptInjection',
};

const providersMock = {
  retrieveFromProvider: 'fn:retrieveFromProvider',
};

const llmMock = {
  callLLM: 'fn:callLLM',
};

let origOrch, origChat, origProv, origLlm, origIdx;

function installMocks() {
  origOrch = require.cache[ORCH_PATH];
  origChat = require.cache[CHAT_PATH];
  origProv = require.cache[PROV_PATH];
  origLlm = require.cache[LLM_PATH];
  origIdx = require.cache[IDX_PATH];

  function entry(id, exports_) {
    const m = new Module(id);
    m.filename = id;
    m.loaded = true;
    m.exports = exports_;
    m.paths = Module._nodeModulePaths(path.dirname(id));
    return m;
  }
  require.cache[ORCH_PATH] = entry(ORCH_PATH, orchestratorMock);
  require.cache[CHAT_PATH] = entry(CHAT_PATH, chatAdapterMock);
  require.cache[PROV_PATH] = entry(PROV_PATH, providersMock);
  require.cache[LLM_PATH] = entry(LLM_PATH, llmMock);
  delete require.cache[IDX_PATH];
}

function restoreMocks() {
  for (const [p, orig] of [
    [ORCH_PATH, origOrch],
    [CHAT_PATH, origChat],
    [PROV_PATH, origProv],
    [LLM_PATH, origLlm],
    [IDX_PATH, origIdx],
  ]) {
    if (orig) require.cache[p] = orig;
    else delete require.cache[p];
  }
}

let searchBrain;

before(() => {
  installMocks();
  searchBrain = require('../src/services/searchBrain');
});

after(() => {
  restoreMocks();
});

beforeEach(() => {
  lastRunOpts = null;
  nextRunResult = { results: [], cohort: 'mixed' };
  lastProjectArg = null;
  nextProjectResult = { citations: [], promptInjection: '', providersUsed: [] };
});

// ── searchAcademic ────────────────────────────────────────────────

describe('searchAcademic', () => {
  it('returns the orchestrator result unchanged', async () => {
    nextRunResult = { results: [{ id: 'r1' }], cohort: 'cs' };
    const out = await searchBrain.searchAcademic({ query: 'test' });
    assert.deepEqual(out, { results: [{ id: 'r1' }], cohort: 'cs' });
  });

  it('forwards options + injects default deps (callLLM, retrieve)', async () => {
    await searchBrain.searchAcademic({ query: 'physics', topK: 5 });
    assert.equal(lastRunOpts.query, 'physics');
    assert.equal(lastRunOpts.topK, 5);
    // Default deps come from the public-entrypoint wiring.
    assert.strictEqual(lastRunOpts.deps.callLLM, 'fn:callLLM');
    assert.strictEqual(lastRunOpts.deps.retrieve, 'fn:retrieveFromProvider');
  });

  it('honours caller-supplied deps.callLLM override', async () => {
    const myLLM = 'my-llm-fn';
    await searchBrain.searchAcademic({ query: 'x', deps: { callLLM: myLLM } });
    assert.strictEqual(lastRunOpts.deps.callLLM, myLLM);
    // Other deps still default.
    assert.strictEqual(lastRunOpts.deps.retrieve, 'fn:retrieveFromProvider');
  });

  it('honours caller-supplied deps.retrieve override', async () => {
    const myRetrieve = 'my-retrieve-fn';
    await searchBrain.searchAcademic({ query: 'x', deps: { retrieve: myRetrieve } });
    assert.strictEqual(lastRunOpts.deps.retrieve, myRetrieve);
  });

  it('forwards deps.now without injecting a default', async () => {
    const myClock = 'my-now-fn';
    await searchBrain.searchAcademic({ query: 'x', deps: { now: myClock } });
    assert.strictEqual(lastRunOpts.deps.now, myClock);
  });

  it('deps.now is undefined when not provided (orchestrator owns the default)', async () => {
    await searchBrain.searchAcademic({ query: 'x' });
    assert.equal(lastRunOpts.deps.now, undefined);
  });
});

// ── searchAcademicForChat ─────────────────────────────────────────

describe('searchAcademicForChat', () => {
  it('runs the pipeline AND returns the projected shape', async () => {
    nextRunResult = { results: [{ id: 'r1' }], cohort: 'cs' };
    nextProjectResult = {
      citations: [{ url: 'https://x' }],
      promptInjection: 'inject',
      providersUsed: ['arxiv', 'semanticScholar'],
    };
    const out = await searchBrain.searchAcademicForChat({ query: 'q' });
    assert.deepEqual(out.response, { results: [{ id: 'r1' }], cohort: 'cs' });
    assert.deepEqual(out.citations, [{ url: 'https://x' }]);
    assert.equal(out.promptInjection, 'inject');
    assert.deepEqual(out.providersUsed, ['arxiv', 'semanticScholar']);
  });

  it('passes the orchestrator response into projectForChat', async () => {
    nextRunResult = { results: [{ id: 'r-passed' }], cohort: 'humanities' };
    await searchBrain.searchAcademicForChat({ query: 'q' });
    assert.deepEqual(lastProjectArg, { results: [{ id: 'r-passed' }], cohort: 'humanities' });
  });

  it('omits extra fields beyond the documented surface', async () => {
    nextProjectResult = {
      citations: [],
      promptInjection: '',
      providersUsed: [],
      extra_internal_field: 'should-not-leak',
    };
    const out = await searchBrain.searchAcademicForChat({ query: 'q' });
    // The wrapper only forwards citations/promptInjection/providersUsed.
    assert.equal('extra_internal_field' in out, false);
  });
});

// ── module exports ────────────────────────────────────────────────

describe('module exports', () => {
  it('exposes the documented public surface', () => {
    const keys = Object.keys(searchBrain).sort();
    assert.deepEqual(keys, [
      'DEFAULT_ACADEMIC_SOURCES',
      'DEFAULT_WEIGHTS',
      'buildPromptInjection',
      'retrieveFromProvider',
      'runSearchBrain',
      'searchAcademic',
      'searchAcademicForChat',
      'toCitation',
    ]);
  });

  it('re-exports runSearchBrain from orchestrator', () => {
    assert.strictEqual(searchBrain.runSearchBrain, orchestratorMock.runSearchBrain);
  });

  it('re-exports retrieveFromProvider from providers', () => {
    assert.strictEqual(searchBrain.retrieveFromProvider, providersMock.retrieveFromProvider);
  });

  it('re-exports toCitation + buildPromptInjection from chatAdapter', () => {
    assert.strictEqual(searchBrain.toCitation, chatAdapterMock.toCitation);
    assert.strictEqual(searchBrain.buildPromptInjection, chatAdapterMock.buildPromptInjection);
  });

  it('re-exports DEFAULT_ACADEMIC_SOURCES + DEFAULT_WEIGHTS from types', () => {
    const types = require('../src/services/searchBrain/types');
    assert.strictEqual(searchBrain.DEFAULT_ACADEMIC_SOURCES, types.DEFAULT_ACADEMIC_SOURCES);
    assert.strictEqual(searchBrain.DEFAULT_WEIGHTS, types.DEFAULT_WEIGHTS);
  });
});
