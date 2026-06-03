/**
 * Filters pipeline — priority ordering, abort semantics, isolation of
 * failing filters, and post-hooks always running (even after abort).
 *
 * Hermetic: the test re-loads `services/agents/filters/index.js` after
 * stubbing the audit-log module so we can assert audit() calls without
 * touching stderr or the filesystem.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const FILTERS_INDEX = path.resolve(__dirname, '../src/services/agents/filters/index.js');
const FILTERS_DIR = path.dirname(FILTERS_INDEX);
const RATE_LIMIT_PATH = path.join(FILTERS_DIR, 'rate-limit.js');
const AUDIT_LOG_PATH = path.resolve(__dirname, '../src/services/agents/audit-log.js');

function clearFilterCache() {
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(FILTERS_DIR)) delete require.cache[k];
  }
  delete require.cache[FILTERS_INDEX];
}

function freshFilters({ auditCapture } = {}) {
  clearFilterCache();
  if (auditCapture) {
    delete require.cache[AUDIT_LOG_PATH];
    require.cache[AUDIT_LOG_PATH] = {
      id: AUDIT_LOG_PATH,
      filename: AUDIT_LOG_PATH,
      loaded: true,
      exports: {
        audit: (rec) => auditCapture.push(rec),
        auditAgentRun: () => {},
        redact: (x) => x,
      },
    };
  }
  // eslint-disable-next-line global-require
  return require(FILTERS_INDEX);
}

describe('filters pipeline', () => {
  beforeEach(() => {
    clearFilterCache();
    // reset rate-limit bucket so tests don't leak counts
    try {
      // eslint-disable-next-line global-require
      const rl = require(RATE_LIMIT_PATH);
      if (typeof rl._resetForTests === 'function') rl._resetForTests();
    } catch (_) { /* noop */ }
  });

  test('runs pre filters in priority order', async () => {
    const audits = [];
    const filters = freshFilters({ auditCapture: audits });
    const ctx = { userId: 'u1', prompt: 'hello', history: [] };
    await filters.runPre(ctx);
    // redact-logs should have set logSafePrompt
    assert.equal(ctx.logSafePrompt, 'hello');
    // metrics started timer
    assert.ok(typeof ctx._metricsStart === 'number');
  });

  test('listFilters returns priority-sorted, enabled-aware view', () => {
    const filters = freshFilters();
    const list = filters.listFilters();
    const priorities = list.map((f) => f.priority);
    const sorted = [...priorities].sort((a, b) => a - b);
    assert.deepEqual(priorities, sorted);
    const translate = list.find((f) => f.id === 'translate-prompt');
    assert.ok(translate);
    assert.equal(translate.enabled, false);
  });

  test('a filter that throws in pre is isolated; other filters still run', async () => {
    const audits = [];
    const filters = freshFilters({ auditCapture: audits });
    // Inject a throwing filter via setFilterOptions on a fake id
    // by mutating FILTERS_CONFIG directly is not enough — we need to
    // patch an existing module. Re-require redact-logs and wrap.
    const redactPath = path.join(FILTERS_DIR, 'redact-logs.js');
    delete require.cache[redactPath];
    const mod = require(redactPath);
    const origPre = mod.pre;
    mod.pre = async function () { throw new Error('boom'); };
    try {
      const ctx = { userId: 'u1', prompt: 'hello', history: [] };
      await filters.runPre(ctx);
      // metrics still ran
      assert.ok(typeof ctx._metricsStart === 'number');
      // error was audited
      const errs = audits.filter((a) => a.event === 'filter_pipeline_error');
      assert.equal(errs.length, 1);
      assert.equal(errs[0].filter, 'redact-logs');
    } finally {
      mod.pre = origPre;
    }
  });

  test('abort in pre short-circuits the pipeline and is reported', async () => {
    const audits = [];
    const filters = freshFilters({ auditCapture: audits });
    const rl = require(RATE_LIMIT_PATH);
    if (typeof rl._resetForTests === 'function') rl._resetForTests();
    filters.setFilterOptions('rate-limit', { windowMs: 60_000, max: 2 });
    const ctx = { userId: 'u-abort', prompt: 'hi', history: [] };
    await filters.runPre(ctx); // 1
    await filters.runPre(ctx); // 2
    const out = await filters.runPre(ctx); // 3 -> abort
    assert.equal(out.aborted, true);
    assert.equal(out.abortFilter, 'rate-limit');
    assert.equal(out.abortStatus, 429);
    const abortAudits = audits.filter((a) => a.event === 'filter_pipeline_abort');
    assert.ok(abortAudits.length >= 1);
    // restore default
    filters.setFilterOptions('rate-limit', {});
  });

  test('post hooks always run, even after abort, so metrics are emitted', async () => {
    const audits = [];
    const filters = freshFilters({ auditCapture: audits });
    const ctx = { userId: 'u2', prompt: 'p', response: 'r', history: [], aborted: true, abortReason: 'test' };
    await filters.runPost(ctx);
    const metrics = audits.filter((a) => a.event === 'filter_pipeline_metrics');
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].aborted, true);
    assert.equal(metrics[0].abortReason, 'test');
  });

  test('disabled filter does not run', async () => {
    const filters = freshFilters();
    // translate-prompt is disabled by default
    const ctx = { userId: 'u3', prompt: 'hola', history: [], language: 'es' };
    await filters.runPre(ctx);
    assert.equal(ctx.translatedToLanguage, undefined);
    // Enable it explicitly
    filters.setFilterEnabled('translate-prompt', true);
    const ctx2 = { userId: 'u3', prompt: 'hola', history: [], language: 'es' };
    await filters.runPre(ctx2);
    assert.equal(ctx2.translatedToLanguage, 'en');
    filters.setFilterEnabled('translate-prompt', false);
  });

  test('scopes act as an opt-in allow-list keyed on ctx.scope', async () => {
      const filters = freshFilters();
      // Monkeypatch translate-prompt with a scope and enable it
      const tpPath = path.join(FILTERS_DIR, 'translate-prompt.js');
      delete require.cache[tpPath];
      const tp = require(tpPath);
      tp.scopes = ['only-here'];
      filters.setFilterEnabled('translate-prompt', true);
      try {
        const ctxOff = { userId: 'u', prompt: 'x', history: [], scope: 'other' };
        await filters.runPre(ctxOff);
        assert.equal(ctxOff.translatedToLanguage, undefined);
        const ctxOn = { userId: 'u', prompt: 'x', history: [], scope: 'only-here' };
        await filters.runPre(ctxOn);
        assert.equal(ctxOn.translatedToLanguage, 'en');
      } finally {
        delete tp.scopes;
        filters.setFilterEnabled('translate-prompt', false);
      }
    });

    test('conversation-memory attaches recent user turns only above threshold', async () => {
    const filters = freshFilters();
    // conversation-memory is disabled by default in production (its internal
    // "Recent user turns" block was leaking into chat replies). Enable it
    // explicitly here so the filter's own threshold logic stays covered.
    filters.setFilterEnabled('conversation-memory', true);
    try {
      const shortHistory = [{ role: 'user', content: 'a' }];
      const longHistory = Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `m${i}`,
      }));
      const ctx1 = { userId: 'u4', prompt: 'p', history: shortHistory };
      await filters.runPre(ctx1);
      assert.equal(ctx1.memoryAttached, undefined);
      const ctx2 = { userId: 'u4', prompt: 'p', history: longHistory };
      await filters.runPre(ctx2);
      assert.ok(ctx2.memoryAttached >= 1);
      assert.ok(ctx2.extraContext.includes('Recent user turns'));
    } finally {
      filters.setFilterEnabled('conversation-memory', false);
    }
  });
});
