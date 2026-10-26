'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { classifyLine } = (() => {
  try {
    // eslint-disable-next-line global-require
    return require('../src/services/observability/live-logs/classify');
  } catch (_) {
    return { classifyLine: null };
  }
})();
const { createSlowQueryObserver, fingerprintOf } = require('../src/db/slow-query-observer');
const { instrumentPool } = require('../src/db/pool-instrumentation');

function sinkSpy() {
  const lines = [];
  return { lines, warn: (line) => lines.push(String(line)) };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('fast queries print nothing; the threshold defaults to 500 ms', () => {
  const sink = sinkSpy();
  const obs = createSlowQueryObserver({ env: {}, sink });
  assert.equal(obs.thresholdMs, 500);
  obs.observe({ model: 'Chat', action: 'findMany', ms: 499, error: null });
  assert.deepEqual(sink.lines, []);
  obs.observe({ model: 'Chat', action: 'findMany', ms: 500, error: null });
  assert.equal(sink.lines.length, 1);
  assert.match(sink.lines[0], /^\[slow-query\] Chat\.findMany 500ms threshold=500ms\b/);
});

test('SIRAGPT_SLOW_QUERY_MS sets the threshold and 0 disables the observer', () => {
  const sink = sinkSpy();
  const strict = createSlowQueryObserver({ env: { SIRAGPT_SLOW_QUERY_MS: '200' }, sink });
  strict.observe({ model: 'User', action: 'findUnique', ms: 250 });
  assert.equal(sink.lines.length, 1);

  const off = createSlowQueryObserver({ env: { SIRAGPT_SLOW_QUERY_MS: '0' }, sink });
  off.observe({ model: 'User', action: 'findUnique', ms: 60_000 });
  assert.equal(sink.lines.length, 1);

  const garbage = createSlowQueryObserver({ env: { SIRAGPT_SLOW_QUERY_MS: 'abc' }, sink });
  assert.equal(garbage.thresholdMs, 500);
});

test('never prints arguments, SQL or error messages (PII)', () => {
  const sink = sinkSpy();
  const obs = createSlowQueryObserver({ env: {}, sink });
  const err = Object.assign(
    new Error('Invalid `prisma.user.findUnique()` invocation: { where: { email: "ana@example.com" } }'),
    { code: 'P2024' },
  );
  obs.observe({
    model: 'User',
    action: 'findUnique',
    ms: 900,
    error: err,
    args: { where: { email: 'ana@example.com' } },
  });
  assert.equal(sink.lines.length, 1);
  assert.doesNotMatch(sink.lines[0], /ana@example\.com|where|Invalid/);
  assert.match(sink.lines[0], / failed code=P2024\b/);

  const named = sinkSpy();
  const obs2 = createSlowQueryObserver({ env: {}, sink: named });
  obs2.observe({ model: 'User', action: 'create', ms: 900, error: new Error('secret text') });
  assert.match(named.lines[0], / failed$|failed /);
  assert.doesNotMatch(named.lines[0], /secret text|code=/);
});

test('one line per model.action per cooldown; repeats are counted with their max duration', () => {
  const sink = sinkSpy();
  const c = clock();
  const obs = createSlowQueryObserver({ env: {}, sink, now: c.now, captureSite: false });
  obs.observe({ model: 'Message', action: 'findMany', ms: 700 });
  c.advance(1_000);
  obs.observe({ model: 'Message', action: 'findMany', ms: 1_900 });
  obs.observe({ model: 'Message', action: 'findMany', ms: 800 });
  obs.observe({ model: 'Message', action: 'count', ms: 600 }); // other fingerprint: own line
  assert.equal(sink.lines.length, 2);

  c.advance(60_000);
  obs.observe({ model: 'Message', action: 'findMany', ms: 650 });
  assert.equal(sink.lines.length, 3);
  assert.match(sink.lines[2], /^\[slow-query\] Message\.findMany 650ms .*suppressed=2 maxMs=1900$/);
  assert.deepEqual(
    { slow: obs.stats().slow, logged: obs.stats().logged, suppressed: obs.stats().suppressed },
    { slow: 5, logged: 3, suppressed: 2 },
  );
});

test('raw and malformed operations fold into bounded fingerprints', () => {
  assert.equal(fingerprintOf(undefined, '$queryRaw'), 'raw.$queryRaw');
  assert.equal(fingerprintOf('Chat', 'findMany'), 'Chat.findMany');
  assert.equal(fingerprintOf('x'.repeat(500), 'findMany'), 'raw.findMany');
  assert.equal(fingerprintOf('Chat', 'drop table; --'), 'Chat.unknown');

  const sink = sinkSpy();
  const obs = createSlowQueryObserver({ env: {}, sink, captureSite: false });
  for (let i = 0; i < 2_000; i += 1) obs.observe({ model: `M${i}`, action: 'findMany', ms: 900 });
  assert.ok(obs.stats().fingerprints <= 1_000);
});

test('a throwing sink never breaks the query path', () => {
  const obs = createSlowQueryObserver({ env: {}, sink: { warn() { throw new Error('boom'); } } });
  assert.doesNotThrow(() => obs.observe({ model: 'Chat', action: 'update', ms: 5_000 }));
});

test('pool instrumentation feeds slow operations to the observer (query extension path)', async () => {
  const sink = sinkSpy();
  const c = clock();
  const obs = createSlowQueryObserver({ env: { SIRAGPT_SLOW_QUERY_MS: '50' }, sink, captureSite: false });
  let extension = null;
  const fakePrisma = {
    $extends(def) { extension = def; return { extended: true }; },
  };
  instrumentPool(fakePrisma, { poolMax: 5, onQuery: obs.observe });
  const op = extension.query.$allOperations;
  await op({ model: 'Chat', operation: 'findMany', args: { where: { userId: 'u1' } }, query: async () => [] });
  assert.deepEqual(sink.lines, []);
  await op({
    model: 'Chat',
    operation: 'findMany',
    args: { where: { userId: 'u1' } },
    query: () => new Promise((resolve) => setTimeout(() => resolve([]), 80)),
  });
  assert.equal(sink.lines.length, 1);
  assert.match(sink.lines[0], /^\[slow-query\] Chat\.findMany \d+ms threshold=50ms/);
  assert.doesNotMatch(sink.lines[0], /u1/);
  void c;
});

test('the shared Prisma client wires the observer into pool instrumentation', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/config/database.js'), 'utf8');
  assert.match(source, /require\(['"]\.\.\/db\/slow-query-observer['"]\)/);
  assert.match(source, /instrumentPool\(basePrisma,\s*\{[\s\S]*?onQuery:\s*slowQueryObserver\.observe/);
});

test('Admin → Logs shows the line as a WARN tagged slow-query', { skip: !classifyLine }, () => {
  const sink = sinkSpy();
  const obs = createSlowQueryObserver({ env: {}, sink, captureSite: false });
  obs.observe({ model: 'Chat', action: 'findMany', ms: 2_300, error: Object.assign(new Error('x'), { code: 'P2024' }) });
  const cls = classifyLine({ text: sink.lines[0], method: 'console.warn' });
  assert.equal(cls.level, 'warn');
  assert.equal(cls.tag, 'slow-query');
});

test('callerSite names the first application frame outside the DB layer and dependencies', () => {
  const { callerSite } = require('../src/db/slow-query-observer');
  const stack = [
    'Error',
    '    at observe (/app/src/db/slow-query-observer.js:80:20)',
    '    at trackOperation (/app/src/db/pool-instrumentation.js:183:21)',
    '    at async a (/app/node_modules/@prisma/client/runtime/library.js:130:9551)',
    '    at async Object.handler (/app/node_modules/some-lib/src/index.js:10:5)',
    '    at async getChat (/app/src/routes/chats.js:212:17)',
  ].join('\n');
  assert.equal(callerSite(stack), 'src/routes/chats.js:212');
  assert.equal(callerSite('Error\n    at x (/home/u/SiraGPT-APP/backend/src/services/a.js:3:1)'), 'src/services/a.js:3');
  assert.equal(callerSite('Error\n    at node:internal/process/task_queues:95:5'), null);
  // A checkout that itself lives under a `src/` folder still anchors on backend/src.
  assert.equal(callerSite([
    'Error',
    '    at observe (/home/u/src/SiraGPT-APP/backend/src/db/slow-query-observer.js:80:20)',
    '    at async getChat (/home/u/src/SiraGPT-APP/backend/src/routes/chats.js:9:3)',
  ].join('\n')), 'src/routes/chats.js:9');
  assert.equal(callerSite('Error\n    at x (C:\\work\\SiraGPT-APP\\backend\\src\\routes\\a.js:7:2)'), 'src/routes/a.js:7');
  // Skips otel-spans / database-guard wrappers and resolves compiled dist/ frames.
  assert.equal(callerSite([
    'Error',
    '    at observe (/app/src/db/slow-query-observer.js:80:20)',
    '    at withDbTransactionSpan (/app/src/utils/otel-spans.js:108:12)',
    '    at PrismaDocSandboxQueueRepository.reconcile (/app/dist/doc-sandbox/queue/repository.js:419:16)',
  ].join('\n')), 'dist/doc-sandbox/queue/repository.js:419');
});

test('background maintenance raw.$queryRaw polls below 5s are suppressed unless an explicit threshold or error is present', () => {
  const { createSlowQueryObserver } = require('../src/db/slow-query-observer');
  const lines = [];
  const obs = createSlowQueryObserver({ env: {}, sink: { warn: (l) => lines.push(l) }, captureSite: false });
  obs.observe({ model: undefined, action: '$queryRaw', ms: 2_900, error: null });
  assert.equal(lines.length, 0, 'routine 2-3s WAL checkpoint pause on background raw.$queryRaw is not logged as slow-query');
  obs.observe({ model: undefined, action: '$queryRaw', ms: 5_100, error: null });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[slow-query\] raw\.\$queryRaw 5100ms threshold=5000ms/);
});

test('a retried P2034 write conflict is named without its code (stays out of «Errores del sistema»)', () => {
  const { createSlowQueryObserver } = require('../src/db/slow-query-observer');
  const lines = [];
  const obs = createSlowQueryObserver({ env: { SIRAGPT_SLOW_QUERY_MS: '10' }, sink: { warn: (l) => lines.push(l) }, captureSite: false });
  obs.observe({ model: 'Message', action: 'create', ms: 40, error: Object.assign(new Error('Transaction failed due to a write conflict'), { code: 'P2034' }) });
  assert.equal(lines.length, 1);
  assert.match(lines[0], / failed write_conflict$/);
  assert.doesNotMatch(lines[0], /\bP[12]\d{3}\b/);
});

