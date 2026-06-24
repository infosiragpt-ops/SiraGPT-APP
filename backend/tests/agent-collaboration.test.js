/**
 * agent-collaboration.test — comprehensive test suite for the
 * enhanced multi-agent coordination layer (node:test style).
 *
 * Uses mock.method on the real agent-task-runner module (enabled by
 * lazy getters in agent-collaboration.js). All infrastructure
 * modules (circuit-breaker, retry, guard, error-telemetry) are real.
 */

'use strict';

const assert = require('node:assert');
const { describe, it, beforeEach, mock } = require('node:test');

// ---------------------------------------------------------------------------
// Mock targets — using mock.method on the real module exports so the
// lazy getters in agent-collaboration.js pick up the mocks.
// ---------------------------------------------------------------------------

const runnerModule = require('../src/services/agents/agent-task-runner');

// ---------------------------------------------------------------------------
// Circuit breaker test helper
// ---------------------------------------------------------------------------

const breakerOpenFlags = new Map();
const origBreaker = require('../src/utils/circuit-breaker');
const OrigCircuitBreaker = origBreaker.CircuitBreaker;

class TestCircuitBreaker extends OrigCircuitBreaker {
  constructor(config) {
    super(config);
    this._testCallCount = 0;
  }

  async call(fn, opts = {}) {
    this._testCallCount++;
    if (breakerOpenFlags.get(this.name)) {
      const err = new Error('circuit breaker is open: ' + this.name);
      err.name = 'CircuitOpenError';
      throw err;
    }
    return super.call(fn, opts);
  }
}

origBreaker.CircuitBreaker = TestCircuitBreaker;

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

const collab = require('../src/services/agents/agent-collaboration');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSubTasks(count = 3, overrides = {}) {
  return Array.from({ length: count }, (_, i) => ({
    goal: `Sub-task ${i + 1}: test goal`,
    taskId: `test-task-${i}`,
    maxSteps: 2,
    maxRuntimeMs: 5000,
    ...overrides,
  }));
}

function makeUser() {
  return { id: 'test-user', name: 'Test User' };
}

function makeResult(overrides = {}) {
  return {
    ok: true,
    output: 'test output',
    markdown: '# Result\n\nContent.',
    summary: 'Test summary',
    artifactIds: ['art-1'],
    steps: [{ tool: 'search' }, { tool: 'finalize' }],
    ...overrides,
  };
}

function resetAll() {
  mock.restoreAll();
  breakerOpenFlags.clear();
  collab.resetBreakers();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validation', () => {
  beforeEach(resetAll);

  it('forkJoin rejects empty subTasks', async () => {
    const r = await collab.forkJoin({ subTasks: [], user: makeUser() });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'no_sub_tasks');
  });

  it('forkJoin rejects missing subTasks', async () => {
    const r = await collab.forkJoin({ user: makeUser() });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'no_sub_tasks');
  });

  it('forkJoin skips null goal silently', async () => {
    const r = await collab.forkJoin({ subTasks: [{ goal: null }], user: makeUser() });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /no_valid_sub_tasks/);
  });

  it('forkJoin skips empty goal silently', async () => {
    const r = await collab.forkJoin({ subTasks: [{ goal: '   ' }], user: makeUser() });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /no_valid_sub_tasks/);
  });

  it('forkJoin rejects over-limit sub-tasks', async () => {
    const many = Array.from({ length: collab.MAX_SUB_AGENTS + 1 }, (_, i) => ({
      goal: `Task ${i}`,
    }));
    const r = await collab.forkJoin({ subTasks: many, user: makeUser() });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /max/);
  });

  it('chain rejects empty subTasks', async () => {
    const r = await collab.chain({ subTasks: [], user: makeUser() });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'no_sub_tasks');
  });

  it('chain skips missing goal silently', async () => {
    const r = await collab.chain({ subTasks: [{ goal: '' }], user: makeUser() });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /no_valid_sub_tasks/);
  });
});

describe('forkJoin', () => {
  beforeEach(resetAll);

  it('all sub-tasks succeed', async () => {
    mock.method(runnerModule, 'runAgentTaskJob', () => makeResult());
    const r = await collab.forkJoin({ subTasks: makeSubTasks(3), user: makeUser() });

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.pattern, 'fork_join');
    assert.strictEqual(r.results.length, 3);
    assert.ok(r.results.every((res) => res.ok));
  });

  it('all sub-tasks fail', async () => {
    mock.method(runnerModule, 'runAgentTaskJob', () => { throw new Error('fail'); });
    const r = await collab.forkJoin({ subTasks: makeSubTasks(3), user: makeUser() });

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.results.length, 3);
    assert.ok(r.results.every((res) => res.ok === false));
  });

  it('partial failures', async () => {
    // Make first mock succeed, rest fail — but since forkJoin runs
    // in parallel, we use a state counter that tracks invocation order
    const invoked = [];
    mock.method(runnerModule, 'runAgentTaskJob', (taskPayload) => {
      const idx = taskPayload?.taskId || invoked.length;
      invoked.push(idx);
      // Fail all odd-numbered taskIds (in the 0,1,2 array)
      if (idx === 'test-task-1') throw new Error('timeout');
      return makeResult();
    });
    mock.method(runnerModule, 'classifyTaskError', () => ({ retryable: false, reason: 'test' }));

    const r = await collab.forkJoin({ subTasks: makeSubTasks(3), user: makeUser(), options: { maxRetries: 0 } });

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.results.filter((res) => res.ok).length, 2);
    assert.strictEqual(r.results.filter((res) => !res.ok).length, 1);
  });

  it('emits events', async () => {
    mock.method(runnerModule, 'runAgentTaskJob', () => makeResult());
    const types = [];
    await collab.forkJoin({
      subTasks: makeSubTasks(2),
      user: makeUser(),
      options: { onEvent: (ev) => types.push(ev.type) },
    });
    assert.ok(types.includes('collab_start'));
    assert.ok(types.includes('collab_done'));
  });

  it('produces mergedSummary', async () => {
    mock.method(runnerModule, 'runAgentTaskJob', () => makeResult({ markdown: '# Work\nContent.' }));
    const r = await collab.forkJoin({ subTasks: makeSubTasks(2), user: makeUser() });

    assert.ok(r.mergedSummary);
    assert.ok(r.mergedSummary.mergedText.includes('Resultado'));
    assert.strictEqual(r.mergedSummary.totalSuccessful, 2);
  });

  it('honours abort signal', async () => {
    mock.method(runnerModule, 'runAgentTaskJob', () => makeResult());
    const ac = new AbortController();
    ac.abort();

    const r = await collab.forkJoin({
      subTasks: makeSubTasks(1),
      user: makeUser(),
      options: { signal: ac.signal },
    });

    // Guard detects aborted signal and fails fast
    assert.strictEqual(r.results[0].ok, false);
  });
});

describe('chain', () => {
  beforeEach(resetAll);

  it('all steps succeed', async () => {
    mock.method(runnerModule, 'runAgentTaskJob', () => makeResult({ output: 'step out' }));
    const r = await collab.chain({ subTasks: makeSubTasks(3), user: makeUser() });

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.results.length, 3);
    assert.ok(r.results.every((res) => res.ok));
  });

  it('stopOnFailure halts at first failure', async () => {
    let callCount = 0;
    mock.method(runnerModule, 'runAgentTaskJob', () => {
      callCount++;
      if (callCount === 2) throw new Error('fail');
      return makeResult();
    });
    mock.method(runnerModule, 'classifyTaskError', () => ({ retryable: false, reason: 'test' }));
    const r = await collab.chain({
      subTasks: makeSubTasks(3),
      user: makeUser(),
      options: { maxRetries: 0 },
    });

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.stoppedAt, 1);
  });

  it('stopOnFailure=false continues past failures', async () => {
    let callCount = 0;
    mock.method(runnerModule, 'runAgentTaskJob', () => {
      callCount++;
      if (callCount === 2) throw new Error('step fail');
      return makeResult();
    });
    mock.method(runnerModule, 'classifyTaskError', () => ({ retryable: false, reason: 'test' }));
    const r = await collab.chain({
      subTasks: makeSubTasks(3),
      user: makeUser(),
      options: { stopOnFailure: false, maxRetries: 0 },
    });

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.results.length, 3);
    assert.strictEqual(r.results[1].ok, false);
    assert.strictEqual(r.results[2].ok, true);
  });

  it('emits step events', async () => {
    mock.method(runnerModule, 'runAgentTaskJob', () => makeResult());
    const types = [];
    await collab.chain({
      subTasks: makeSubTasks(2),
      user: makeUser(),
      options: { onEvent: (ev) => types.push(ev.type) },
    });
    assert.ok(types.includes('collab_step_start'));
    assert.ok(types.includes('collab_done'));
  });
});

describe('forkVote', () => {
  beforeEach(resetAll);

  it('selects winner via LLM judge', async () => {
    mock.method(runnerModule, 'runAgentTaskJob', () => makeResult());
    const llm = mock.fn(() => ({
      choices: [{
        message: {
          content: JSON.stringify({
            scores: [
              { index: 0, criteria: { relevance: 9 }, total: 85 },
              { index: 1, criteria: { relevance: 7 }, total: 65 },
            ],
            winnerIndex: 0,
            reason: 'more thorough',
          }),
        },
      }],
    }));

    const r = await collab.forkVote({
      subTasks: makeSubTasks(2),
      user: makeUser(),
      options: { openai: { chat: { completions: { create: llm } } } },
    });

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.vote.method, 'llm_judge');
    assert.strictEqual(r.vote.winner, 0);
  });

  it('falls back to heuristic when LLM fails', async () => {
    mock.method(runnerModule, 'runAgentTaskJob', () => makeResult());
    const r = await collab.forkVote({
      subTasks: makeSubTasks(2),
      user: makeUser(),
      options: {
        openai: { chat: { completions: { create: () => { throw new Error('down'); } } } },
      },
    });

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.vote.method, 'heuristic');
    assert.strictEqual(typeof r.vote.winner, 'number');
  });

  it('single candidate returns immediate winner', async () => {
    let callCount = 0;
    mock.method(runnerModule, 'runAgentTaskJob', () => {
      callCount++;
      if (callCount === 2) throw new Error('fail');
      return makeResult();
    });
    mock.method(runnerModule, 'classifyTaskError', () => ({ retryable: false, reason: 'test' }));
    const r = await collab.forkVote({
      subTasks: makeSubTasks(2),
      user: makeUser(),
      options: { maxRetries: 0 },
    });

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.vote.method, 'single_winner');
    assert.strictEqual(r.vote.winner, 0);
  });

  it('no candidates returns failed result', async () => {
    mock.method(runnerModule, 'runAgentTaskJob', () => { throw new Error('fail'); });
    const r = await collab.forkVote({ subTasks: makeSubTasks(2), user: makeUser() });

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.vote.winner, null);
  });
});

describe('forkReview', () => {
  beforeEach(resetAll);

  it('reviews and picks best', async () => {
    mock.method(runnerModule, 'runAgentTaskJob', () => makeResult());
    const llm = mock.fn(() => ({
      choices: [{
        message: {
          content: JSON.stringify({
            scores: { accuracy: 9, completeness: 8 },
            averageScore: 8.5,
            strengths: ['good'],
            weaknesses: [],
            recommendation: 'accept',
          }),
        },
      }],
    }));

    const r = await collab.forkReview({
      subTasks: makeSubTasks(2),
      user: makeUser(),
      options: { openai: { chat: { completions: { create: llm } } } },
    });

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.reviews.length, 2);
    assert.strictEqual(typeof r.bestIndex, 'number');
  });

  it('no successful results', async () => {
    mock.method(runnerModule, 'runAgentTaskJob', () => { throw new Error('fail'); });
    const r = await collab.forkReview({ subTasks: makeSubTasks(2), user: makeUser() });

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reviews.length, 0);
    assert.strictEqual(r.bestIndex, null);
  });

  it('uses heuristic without LLM', async () => {
    mock.method(runnerModule, 'runAgentTaskJob', () => makeResult());
    const r = await collab.forkReview({ subTasks: makeSubTasks(2), user: makeUser() });

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.reviews.length, 2);
    assert.ok(r.reviews[0].averageScore >= 0);
  });
});

describe('decomposeGoal', () => {
  beforeEach(resetAll);

  it('returns empty for empty input', async () => {
    assert.deepStrictEqual(await collab.decomposeGoal(''), []);
    assert.deepStrictEqual(await collab.decomposeGoal(null), []);
    assert.deepStrictEqual(await collab.decomposeGoal('   '), []);
  });

  it('regex splits on transition words', async () => {
    const parts = await collab.decomposeGoal(
      'Search PubMed for RCTs and compile an Excel table and write a summary',
      { maxParts: 3 },
    );
    assert.ok(parts.length >= 2, `expected >=2, got ${parts.length}`);
    assert.ok(parts.every((p) => p.goal.length > 0));
    assert.strictEqual(parts[0].context.source, 'regex');
  });

  it('regex splits Spanish text', async () => {
    const parts = await collab.decomposeGoal(
      'Analiza los datos y genera un reporte y finalmente exporta a PDF',
      { maxParts: 3 },
    );
    assert.ok(parts.length >= 2, `expected >=2, got ${parts.length}`);
  });

  it('LLM decomposition works', async () => {
    const llm = mock.fn(() => ({
      choices: [{
        message: {
          content: JSON.stringify({
            subTasks: ['Research paper A', 'Summarize key findings', 'Generate DOCX'],
          }),
        },
      }],
    }));

    const parts = await collab.decomposeGoal('Do research', {
      openai: { chat: { completions: { create: llm } } },
      maxParts: 5,
    });
    assert.strictEqual(parts.length, 3);
    assert.strictEqual(parts[0].context.source, 'llm');
  });

  it('LLM falls back to regex on parse failure', async () => {
    const parts = await collab.decomposeGoal('Search and compile and summarize', {
      openai: { chat: { completions: { create: () => ({ choices: [{ message: { content: 'bad json' } }] }) } } },
      maxParts: 3,
    });
    assert.ok(parts.length >= 2, `expected >=2, got ${parts.length}`);
    assert.strictEqual(parts[0].context.source, 'regex');
  });

  it('LLM falls back on API rejection', async () => {
    const parts = await collab.decomposeGoal('first and second', {
      openai: { chat: { completions: { create: () => { throw new Error('API err'); } } } },
    });
    assert.ok(parts.length >= 1);
  });

  it('respects maxParts limit', async () => {
    const llm = mock.fn(() => ({
      choices: [{
        message: {
          content: JSON.stringify({
            subTasks: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'],
          }),
        },
      }],
    }));
    const parts = await collab.decomposeGoal('complex', {
      openai: { chat: { completions: { create: llm } } },
      maxParts: 3,
    });
    assert.ok(parts.length <= 3);
  });
});

describe('breaker diagnostics', () => {
  beforeEach(resetAll);

  it('getBreakerStates returns states', async () => {
    mock.method(runnerModule, 'runAgentTaskJob', () => makeResult());
    await collab.forkJoin({ subTasks: makeSubTasks(2), user: makeUser() });

    const states = collab.getBreakerStates();
    assert.ok(Array.isArray(states));
    assert.ok(states.length >= 2);
    assert.ok('name' in states[0]);
    assert.ok('state' in states[0]);
  });

  it('breakers use the intended threshold=3 / probeCount=2 (not library defaults 5/1)', async () => {
    // Regression: DEFAULT_CB_CONFIG declared failureThreshold/successThreshold,
    // which CircuitBreaker's sanitizeOptions ignores (it reads threshold/
    // probeCount), so breakers silently ran at the lenient defaults.
    mock.method(runnerModule, 'runAgentTaskJob', () => makeResult());
    await collab.forkJoin({ subTasks: makeSubTasks(1), user: makeUser() });

    const state = collab.getBreakerStates()[0];
    assert.strictEqual(state.threshold, 3);
    assert.strictEqual(state.probeCount, 2);
  });

  it('resetBreakers clears state', async () => {
    mock.method(runnerModule, 'runAgentTaskJob', () => makeResult());
    await collab.forkJoin({ subTasks: makeSubTasks(1), user: makeUser() });
    assert.ok(collab.getBreakerStates().length > 0);

    collab.resetBreakers();
    assert.strictEqual(collab.getBreakerStates().length, 0);
  });
});

describe('error handling', () => {
  beforeEach(resetAll);

  it('detects circuit open error', async () => {
    // Simulate a CircuitOpenError from the breaker path
    // The error name 'CircuitOpenError' triggers circuitOpen=true detection
    mock.method(runnerModule, 'runAgentTaskJob', () => {
      const err = new Error('circuit breaker is open: agent-subtask');
      err.name = 'CircuitOpenError';
      throw err;
    });
    mock.method(runnerModule, 'classifyTaskError', () => ({ retryable: false, reason: 'test' }));

    const r = await collab.forkJoin({
      subTasks: makeSubTasks(1),
      user: makeUser(),
      options: { maxRetries: 0 },
    });

    assert.strictEqual(r.results[0].circuitOpen, true);
    assert.strictEqual(r.results[0].ok, false);
  });
});

describe('event emission', () => {
  beforeEach(resetAll);

  it('forkVote emits collab_vote', async () => {
    mock.method(runnerModule, 'runAgentTaskJob', () => makeResult());
    const types = [];
    await collab.forkVote({
      subTasks: makeSubTasks(2),
      user: makeUser(),
      options: { onEvent: (ev) => types.push(ev.type) },
    });
    assert.ok(types.includes('collab_vote'));
  });

  it('forkReview emits collab_review', async () => {
    mock.method(runnerModule, 'runAgentTaskJob', () => makeResult());
    const types = [];
    await collab.forkReview({
      subTasks: makeSubTasks(2),
      user: makeUser(),
      options: { onEvent: (ev) => types.push(ev.type) },
    });
    assert.ok(types.includes('collab_review'));
  });

  it('bad onEvent handler does not crash', async () => {
    mock.method(runnerModule, 'runAgentTaskJob', () => makeResult());
    const r = await collab.forkJoin({
      subTasks: makeSubTasks(1),
      user: makeUser(),
      options: { onEvent: () => { throw new Error('crash'); } },
    });
    assert.strictEqual(r.ok, true);
  });
});

describe('internal helpers', () => {
  describe('truncateGoal', () => {
    it('short unchanged', () => {
      assert.strictEqual(collab._internals.truncateGoal('hi', 80), 'hi');
    });
    it('long truncated', () => {
      const r = collab._internals.truncateGoal('a'.repeat(100), 20);
      assert.strictEqual(r.length, 20);
      assert.match(r, /\.\.\.$/);
    });
    it('empty/non-string', () => {
      assert.strictEqual(collab._internals.truncateGoal(''), '');
      assert.strictEqual(collab._internals.truncateGoal(null), '');
    });
  });

  describe('validateSubTasks', () => {
    it('valid returns null', () => {
      assert.strictEqual(collab._internals.validateSubTasks([{ goal: 'x' }]), null);
    });
    it('empty returns error', () => {
      assert.strictEqual(collab._internals.validateSubTasks([]).error, 'no_sub_tasks');
    });
  });

  describe('mergeForkResults', () => {
    it('empty on all failures', () => {
      const s = collab._internals.mergeForkResults([{ index: 0, ok: false, error: 'e' }]);
      assert.strictEqual(s.mergedText, '');
      assert.strictEqual(s.totalSuccessful, 0);
    });
    it('collects artifact IDs', () => {
      const s = collab._internals.mergeForkResults([
        { index: 0, ok: true, result: { artifactIds: ['a1'] } },
        { index: 1, ok: true, result: { artifactIds: ['a2', 'a3'] } },
      ]);
      assert.deepStrictEqual(s.artifactIds, ['a1', 'a2', 'a3']);
    });
  });
});
