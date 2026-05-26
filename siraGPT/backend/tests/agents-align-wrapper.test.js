/**
 * Tests for services/agents/align-wrapper.js — end-to-end alignment
 * pipeline (clarifier → exemplars → execute → judge → truthfulness +
 * safety + calibration, with retry).
 */

'use strict';

const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');
const { describe, it, before, after, beforeEach } = require('node:test');

const JUDGE_PATH = require.resolve('../src/services/agents/alignment-judge');
const CLAR_PATH = require.resolve('../src/services/agents/intent-clarifier');
const TRUTH_PATH = require.resolve('../src/services/agents/truthfulness');
const SAFETY_PATH = require.resolve('../src/services/agents/safety-filter');
const FB_PATH = require.resolve('../src/services/agents/feedback-ledger');
const CALIB_PATH = require.resolve('../src/services/agents/response-calibrator');
const WRAP_PATH = require.resolve('../src/services/agents/align-wrapper');

// Dispatcher-pattern mocks for every dependency.
const judgeMock = {
  _next: async () => ({ overall: 9, helpful: 9, honest: 9, harmless: 9, issues: [], reasoning: '' }),
  score: (...args) => judgeMock._next(...args),
};
const clarMock = {
  _next: async () => ({ status: 'clear' }),
  clarify: (...args) => clarMock._next(...args),
};
const truthMock = {
  _next: async () => ({ claims: [], unfoundedCount: 0, score: 1, summary: 'no claims' }),
  check: (...args) => truthMock._next(...args),
};
const safetyMock = {
  _next: async () => ({ flagged: false, findings: [], counts: {}, summary: 'clean' }),
  check: (...args) => safetyMock._next(...args),
};
const fbMock = {
  _exemplars: async () => [],
  _format: () => '',
  findExemplars: (...args) => fbMock._exemplars(...args),
  formatExemplarsBlock: (...args) => fbMock._format(...args),
};
const calibMock = {
  _next: async () => ({ flagged: false, findings: [], summary: 'fine' }),
  calibrate: (...args) => calibMock._next(...args),
};

const cacheBackup = {};
function installMocks() {
  for (const [p, mock] of [
    [JUDGE_PATH, judgeMock], [CLAR_PATH, clarMock], [TRUTH_PATH, truthMock],
    [SAFETY_PATH, safetyMock], [FB_PATH, fbMock], [CALIB_PATH, calibMock],
  ]) {
    cacheBackup[p] = require.cache[p];
    const m = new Module(p);
    m.filename = p;
    m.loaded = true;
    m.exports = mock;
    m.paths = Module._nodeModulePaths(path.dirname(p));
    require.cache[p] = m;
  }
  cacheBackup[WRAP_PATH] = require.cache[WRAP_PATH];
  delete require.cache[WRAP_PATH];
}

function restoreMocks() {
  for (const p of Object.keys(cacheBackup)) {
    if (cacheBackup[p]) require.cache[p] = cacheBackup[p];
    else delete require.cache[p];
  }
}

let wrap;

before(() => {
  installMocks();
  wrap = require('../src/services/agents/align-wrapper');
});

after(() => {
  restoreMocks();
});

beforeEach(() => {
  judgeMock._next = async () => ({ overall: 9, helpful: 9, honest: 9, harmless: 9, issues: [], reasoning: '' });
  clarMock._next = async () => ({ status: 'clear' });
  truthMock._next = async () => ({ claims: [], unfoundedCount: 0, score: 1, summary: 'no claims' });
  safetyMock._next = async () => ({ flagged: false, findings: [], counts: {}, summary: 'clean' });
  fbMock._exemplars = async () => [];
  fbMock._format = () => '';
  calibMock._next = async () => ({ flagged: false, findings: [], summary: 'fine' });
});

// ── constants ────────────────────────────────────────────────────

describe('constants', () => {
  it('DEFAULT_MIN_SCORE = 6 (retry threshold)', () => {
    assert.equal(wrap.DEFAULT_MIN_SCORE, 6);
  });

  it('DEFAULT_MAX_RETRIES = 1 (cost-bounded)', () => {
    assert.equal(wrap.DEFAULT_MAX_RETRIES, 1);
  });

  it('DEFAULT_EXEMPLAR_K = 2', () => {
    assert.equal(wrap.DEFAULT_EXEMPLAR_K, 2);
  });
});

// ── summariseResult ─────────────────────────────────────────────

describe('summariseResult', () => {
  it('returns string input unchanged', () => {
    assert.equal(wrap.summariseResult('hello'), 'hello');
  });

  it('returns "" for null/undefined', () => {
    assert.equal(wrap.summariseResult(null), '');
    assert.equal(wrap.summariseResult(undefined), '');
  });

  it('prefers code → test_file → hypothesis → summary → annotatedText', () => {
    assert.equal(wrap.summariseResult({ code: 'fn x() {}', summary: 'sum' }), 'fn x() {}');
    assert.equal(wrap.summariseResult({ test_file: 'tests', summary: 'sum' }), 'tests');
    assert.equal(wrap.summariseResult({ hypothesis: 'h', summary: 'sum' }), 'h');
    assert.equal(wrap.summariseResult({ summary: 'sum' }), 'sum');
    assert.equal(wrap.summariseResult({ annotatedText: 'ann' }), 'ann');
  });

  it('JSON-stringifies (truncated to 8000) when no candidate field', () => {
    const out = wrap.summariseResult({ x: 1, y: 'z' });
    assert.match(out, /"x":1/);
    assert.match(out, /"y":"z"/);
  });

  it('falls back to "" on JSON.stringify failure (circular ref)', () => {
    const a = {}; a.self = a;
    assert.equal(wrap.summariseResult(a), '');
  });
});

// ── flattenContextChunks ────────────────────────────────────────

describe('flattenContextChunks', () => {
  it('returns "" for empty/null/non-array', () => {
    assert.equal(wrap.flattenContextChunks([]), '');
    assert.equal(wrap.flattenContextChunks(null), '');
    assert.equal(wrap.flattenContextChunks('not-array'), '');
  });

  it('formats numbered chunks with source labels', () => {
    const out = wrap.flattenContextChunks([
      { text: 'A', source: 'a.md' },
      { text: 'B' },
    ]);
    assert.match(out, /\[1 a\.md\] A/);
    assert.match(out, /\[2\] B/);
  });

  it('caps at 15 chunks', () => {
    const chunks = Array.from({ length: 30 }, (_, i) => ({ text: `c${i}` }));
    const out = wrap.flattenContextChunks(chunks);
    const matches = out.match(/^\[\d+/gm);
    assert.equal(matches.length, 15);
  });

  it('truncates each chunk text to 500 chars', () => {
    const out = wrap.flattenContextChunks([{ text: 'x'.repeat(2000) }]);
    const text = out.split('] ')[1];
    assert.ok(text.length <= 500);
  });
});

// ── buildExemplarsBlock ─────────────────────────────────────────

describe('buildExemplarsBlock', () => {
  it('returns "" when findExemplars throws (no embedder, etc.)', async () => {
    fbMock._exemplars = async () => { throw new Error('no embedder'); };
    const out = await wrap.buildExemplarsBlock({
      userId: 'u', request: 'q', agent: 'x', embedder: null,
    });
    assert.equal(out, '');
  });

  it('formats exemplars when available', async () => {
    fbMock._exemplars = async () => [{ request: 'r', response: 'a', agent: 'x' }];
    fbMock._format = () => '# EXAMPLES\n## Example 1\nQ: r\nA: a';
    const out = await wrap.buildExemplarsBlock({
      userId: 'u', request: 'q', agent: 'x',
    });
    assert.match(out, /EXAMPLES/);
  });
});

// ── runAligned · validation ─────────────────────────────────────

describe('runAligned · validation', () => {
  it('throws when run is not a function', async () => {
    await assert.rejects(
      () => wrap.runAligned({ openai: {}, userId: 'u', agentName: 'a', userRequest: 'r' }),
      /`run` function is required/,
    );
  });
});

// ── runAligned · clarification gates ────────────────────────────

describe('runAligned · clarifier gates', () => {
  it('short-circuits with status=needs_clarification when clarifier flags ambiguous', async () => {
    clarMock._next = async () => ({
      status: 'ambiguous', questions: ['which file?', 'which function?'],
    });
    let ranSpecialist = false;
    const out = await wrap.runAligned({
      openai: {}, userId: 'u', agentName: 'a', userRequest: 'r',
      run: async () => { ranSpecialist = true; return 'x'; },
    });
    assert.equal(out.status, 'needs_clarification');
    assert.deepEqual(out.questions, ['which file?', 'which function?']);
    assert.equal(out.result, null);
    assert.equal(ranSpecialist, false);
  });

  it('short-circuits with status=blocked when clarifier returns blocked', async () => {
    clarMock._next = async () => ({ status: 'blocked', reason: 'out of scope' });
    const out = await wrap.runAligned({
      openai: {}, userId: 'u', agentName: 'a', userRequest: 'r',
      run: async () => 'x',
    });
    assert.equal(out.status, 'blocked');
    assert.equal(out.blocked_reason, 'out of scope');
  });

  it('skipClarifier=true bypasses the clarifier', async () => {
    let clarifierCalled = false;
    clarMock._next = async () => { clarifierCalled = true; return { status: 'clear' }; };
    await wrap.runAligned({
      openai: {}, userId: 'u', agentName: 'a', userRequest: 'r',
      run: async () => 'x',
      opts: { skipClarifier: true },
    });
    assert.equal(clarifierCalled, false);
  });
});

// ── runAligned · happy path ─────────────────────────────────────

describe('runAligned · happy path', () => {
  it('returns status=ok with alignment + truthfulness + safety + calibration', async () => {
    const out = await wrap.runAligned({
      openai: {}, userId: 'u', agentName: 'a', userRequest: 'r',
      run: async () => 'specialist output',
      contextChunks: [{ text: 'context', source: 's' }],
    });
    assert.equal(out.status, 'ok');
    assert.equal(out.result, 'specialist output');
    assert.ok(out.alignment);
    assert.equal(out.alignment.score, 9);
    assert.ok(out.truthfulness);
    assert.ok(out.safety);
    assert.ok(out.calibration);
    assert.equal(out.retries_used, 0);
  });

  it('passes augmentedGoal (exemplars block) to the specialist run()', async () => {
    fbMock._exemplars = async () => [{ request: 'r', response: 'a', agent: 'a' }];
    fbMock._format = () => '# EXEMPLARS\n## Example 1\nQ: r\nA: a';
    let capturedGoal = null;
    await wrap.runAligned({
      openai: {}, userId: 'u', agentName: 'a', userRequest: 'r',
      run: async ({ augmentedGoal }) => {
        capturedGoal = augmentedGoal;
        return 'r';
      },
    });
    assert.match(capturedGoal, /EXEMPLARS/);
  });

  it('counts exemplars_used from "## Example " occurrences', async () => {
    fbMock._exemplars = async () => [{}, {}, {}];
    fbMock._format = () => '# H\n## Example 1\nA\n## Example 2\nB\n## Example 3\nC';
    const out = await wrap.runAligned({
      openai: {}, userId: 'u', agentName: 'a', userRequest: 'r',
      run: async () => 'r',
    });
    assert.equal(out.exemplars_used, 3);
  });

  it('truthfulness section is null when no contextChunks supplied', async () => {
    const out = await wrap.runAligned({
      openai: {}, userId: 'u', agentName: 'a', userRequest: 'r',
      run: async () => 'r',
    });
    assert.equal(out.truthfulness, null);
  });

  it('truthfulness failure surfaces as "skipped: ..." summary, not a throw', async () => {
    truthMock._next = async () => { throw new Error('truth down'); };
    const out = await wrap.runAligned({
      openai: {}, userId: 'u', agentName: 'a', userRequest: 'r',
      run: async () => 'r',
      contextChunks: [{ text: 'ctx' }],
    });
    assert.equal(out.status, 'ok');
    assert.match(out.truthfulness.summary, /skipped.*truth down/);
  });

  it('safety failure surfaces as "skipped: ..." summary, not a throw', async () => {
    safetyMock._next = async () => { throw new Error('safety down'); };
    const out = await wrap.runAligned({
      openai: {}, userId: 'u', agentName: 'a', userRequest: 'r',
      run: async () => 'r',
    });
    assert.equal(out.status, 'ok');
    assert.match(out.safety.summary, /skipped.*safety down/);
  });

  it('calibration failure surfaces as "skipped: ..." summary, not a throw', async () => {
    calibMock._next = async () => { throw new Error('calib down'); };
    const out = await wrap.runAligned({
      openai: {}, userId: 'u', agentName: 'a', userRequest: 'r',
      run: async () => 'r',
    });
    assert.equal(out.status, 'ok');
    assert.match(out.calibration.summary, /skipped.*calib down/);
  });
});

// ── runAligned · retry mechanics ────────────────────────────────

describe('runAligned · retry mechanics', () => {
  it('retries when alignment.overall < minScore and bumps retries_used', async () => {
    let attempt = 0;
    judgeMock._next = async () => {
      attempt += 1;
      return {
        overall: attempt === 1 ? 4 : 9,
        helpful: 9, honest: 9, harmless: 9,
        issues: ['too short'], reasoning: 'r',
      };
    };
    let runCount = 0;
    const out = await wrap.runAligned({
      openai: {}, userId: 'u', agentName: 'a', userRequest: 'r',
      run: async () => { runCount += 1; return `attempt-${runCount}`; },
    });
    assert.equal(runCount, 2);
    assert.equal(out.retries_used, 1);
    assert.equal(out.result, 'attempt-2');
  });

  it('honours opts.maxRetries cap (no retry when 0)', async () => {
    judgeMock._next = async () => ({ overall: 4, helpful: 4, honest: 4, harmless: 4, issues: [], reasoning: '' });
    let runCount = 0;
    const out = await wrap.runAligned({
      openai: {}, userId: 'u', agentName: 'a', userRequest: 'r',
      run: async () => { runCount += 1; return 'r'; },
      opts: { maxRetries: 0 },
    });
    assert.equal(runCount, 1);
    assert.equal(out.retries_used, 0);
  });

  it('honours opts.minScore (raises retry bar)', async () => {
    judgeMock._next = async () => ({ overall: 7, helpful: 7, honest: 7, harmless: 7, issues: [], reasoning: '' });
    let runCount = 0;
    await wrap.runAligned({
      openai: {}, userId: 'u', agentName: 'a', userRequest: 'r',
      run: async () => { runCount += 1; return 'r'; },
      opts: { minScore: 9 },
    });
    // 7 < 9 → retry; default maxRetries=1 → 2 runs total.
    assert.equal(runCount, 2);
  });

  it('passes critique to the second attempt (issues list shown to specialist)', async () => {
    let attempt = 0;
    const receivedCritiques = [];
    judgeMock._next = async () => {
      attempt += 1;
      return {
        overall: attempt === 1 ? 4 : 9,
        helpful: 5, honest: 5, harmless: 5,
        issues: ['weak example', 'missing rationale'], reasoning: '',
      };
    };
    await wrap.runAligned({
      openai: {}, userId: 'u', agentName: 'a', userRequest: 'r',
      run: async ({ critique }) => { receivedCritiques.push(critique); return 'r'; },
    });
    assert.equal(receivedCritiques[0], null);
    assert.match(receivedCritiques[1], /weak example/);
    assert.match(receivedCritiques[1], /missing rationale/);
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const keys = Object.keys(wrap).sort();
    assert.deepEqual(keys, [
      'DEFAULT_EXEMPLAR_K', 'DEFAULT_MAX_RETRIES', 'DEFAULT_MIN_SCORE',
      'buildExemplarsBlock', 'flattenContextChunks',
      'runAligned', 'summariseResult',
    ]);
  });
});
