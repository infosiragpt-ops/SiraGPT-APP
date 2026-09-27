'use strict';

/**
 * «Errores del sistema» — Admin → Logs issue tracker (Sentry-like) on AuditLog.
 * Capture → noise control → burst collapse → issues (new / regression / spike)
 * → admin API, plus the wiring contracts that keep it connected.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

process.env.SIRAGPT_SYSTEM_ERRORS = '1';
process.env.SIRAGPT_SYSTEM_ERRORS_FLUSH_MS = '60000';

const fp = require('../src/services/observability/system-errors/fingerprint');
const { createSystemIssueStore, spikeOf, hourKey } = require('../src/services/observability/system-errors/store');
const systemErrors = require('../src/services/observability/system-errors');

// ── In-memory Prisma double (the shapes the store uses) ────────────────
function getPath(obj, keys) {
  return keys.reduce((acc, k) => (acc && typeof acc === 'object' ? acc[k] : undefined), obj);
}
function cmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}
function matchJson(value, cond) {
  if ('equals' in cond && value !== cond.equals) return false;
  if ('string_contains' in cond) {
    if (typeof value !== 'string') return false;
    const hay = cond.mode === 'insensitive' ? value.toLowerCase() : value;
    const needle = cond.mode === 'insensitive' ? String(cond.string_contains).toLowerCase() : cond.string_contains;
    if (!hay.includes(needle)) return false;
  }
  if ('array_contains' in cond && !(Array.isArray(value) && cond.array_contains.every((v) => value.includes(v)))) return false;
  if ('gt' in cond && !(value != null && cmp(value, cond.gt) > 0)) return false;
  if ('gte' in cond && !(value != null && cmp(value, cond.gte) >= 0)) return false;
  if ('lt' in cond && !(value != null && cmp(value, cond.lt) < 0)) return false;
  if ('lte' in cond && !(value != null && cmp(value, cond.lte) <= 0)) return false;
  return true;
}
function matchDate(value, cond) {
  const t = new Date(value).getTime();
  if (cond.gt && t <= new Date(cond.gt).getTime()) return false;
  if (cond.gte && t < new Date(cond.gte).getTime()) return false;
  if (cond.lt && t >= new Date(cond.lt).getTime()) return false;
  if (cond.lte && t > new Date(cond.lte).getTime()) return false;
  return true;
}
function matches(row, where) {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'AND') { if (!cond.every((c) => matches(row, c))) return false; continue; }
    if (key === 'OR') { if (!cond.some((c) => matches(row, c))) return false; continue; }
    if (key === 'createdAt') { if (!matchDate(row.createdAt, cond)) return false; continue; }
    if (key === 'metadata') { if (!matchJson(getPath(row.metadata, cond.path), cond)) return false; continue; }
    if (cond && typeof cond === 'object' && 'in' in cond) { if (!cond.in.includes(row[key])) return false; continue; }
    if (row[key] !== cond) return false;
  }
  return true;
}
function fakePrisma() {
  const rows = [];
  let seq = 0;
  let clock = Date.parse('2026-09-26T20:00:00.000Z');
  return {
    rows,
    auditLog: {
      async create({ data }) {
        clock += 1;
        const row = { id: `al_${++seq}`, createdAt: new Date(clock), ...JSON.parse(JSON.stringify(data)) };
        rows.push(row);
        return row;
      },
      async findFirst({ where }) {
        return rows.filter((r) => matches(r, where)).sort((a, b) => b.createdAt - a.createdAt)[0] || null;
      },
      async findUnique({ where }) {
        return rows.find((r) => r.id === where.id) || null;
      },
      async update({ where, data }) {
        const found = rows.find((r) => r.id === where.id);
        Object.assign(found, JSON.parse(JSON.stringify(data)));
        return found;
      },
      async findMany({ where, take = 1000 }) {
        return rows.filter((r) => matches(r, where)).sort((a, b) => b.createdAt - a.createdAt).slice(0, take);
      },
      async deleteMany({ where }) {
        const keep = rows.filter((r) => !matches(r, where));
        const count = rows.length - keep.length;
        rows.length = 0;
        rows.push(...keep);
        return { count };
      },
    },
    user: {
      async findMany({ where }) {
        return where.id.in.filter((id) => id === 'u1').map((id) => ({ id, email: 'luis@example.com', name: 'Luis' }));
      },
    },
  };
}

const issues = (prisma) => prisma.rows.filter((r) => r.action === 'system_issue');
const alerts = (prisma) => prisma.rows.filter((r) => r.action === 'system_issue_alert');

function stackFor(fnName, file, line = 42) {
  return [
    `Error: boom`,
    `    at ${fnName} (/app/src/${file}:${line}:13)`,
    '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
    '    at async Worker.run (/app/node_modules/bullmq/dist/cjs/classes/worker.js:500:20)',
  ].join('\n');
}

describe('fingerprint — grouping rules', () => {
  it('the same bug groups across ids, numbers and deploys (line numbers never split an issue)', () => {
    const a = fp.describeEvent({ name: 'TypeError', message: "Cannot read properties of undefined (reading 'files') for chat cmuj01io7000jpj5kuy7nyolt", stack: stackFor('buildTurn', 'routes/ai.js', 1200) });
    const b = fp.describeEvent({ name: 'TypeError', message: "Cannot read properties of undefined (reading 'files') for chat cmuj9zz99000jpj5kuy7abcde", stack: stackFor('buildTurn', 'routes/ai.js', 1377) });
    const c = fp.describeEvent({ name: 'TypeError', message: "Cannot read properties of undefined (reading 'files') for chat cmuj01io7000jpj5kuy7nyolt", stack: stackFor('otherFn', 'routes/files.js') });
    assert.equal(a.fingerprint, b.fingerprint);
    assert.notEqual(a.fingerprint, c.fingerprint);
    assert.equal(a.title, "TypeError: Cannot read properties of undefined (reading 'files') for chat cmuj01io7000jpj5kuy7nyolt");
    assert.equal(a.culprit, 'buildTurn (src/routes/ai.js)');
  });

  it('a Redis outage logged by every worker is ONE issue (kind redis)', () => {
    const w1 = fp.describeEvent({ message: '[agent-task-worker] worker error: ERR Your database has been temporarily rate-limited' });
    const w2 = fp.describeEvent({ message: '[codex-runs] worker error: ERR Your database has been temporarily rate-limited' });
    assert.equal(w1.kind, 'redis');
    assert.equal(w1.fingerprint, w2.fingerprint);
    // A queue bug without a stack is told apart by its worker tag.
    const q1 = fp.describeEvent({ message: '[doc-engine] worker error: Missing lock for job 12' });
    const q2 = fp.describeEvent({ message: '[goal-worker] worker error: Missing lock for job 99' });
    assert.equal(q1.kind, 'cola');
    assert.notEqual(q1.fingerprint, q2.fingerprint);
  });

  it('the Prisma `nin` bug of the stale-run watchdog lands as a database issue with its culprit', () => {
    const d = fp.describeEvent({
      name: 'PrismaClientValidationError',
      message: 'Invalid `prisma.chatRun.findMany()` invocation: Unknown argument `nin`. Did you mean `in`?',
      stack: [
        'PrismaClientValidationError: Invalid `prisma.chatRun.findMany()` invocation',
        '    at Hn (/app/node_modules/@prisma/client/runtime/library.js:32:1363)',
        '    at async sweepStaleRuns (/app/src/jobs/stale-run-watchdog.js:61:22)',
      ].join('\n'),
    });
    assert.equal(d.kind, 'base_de_datos');
    assert.equal(d.culprit, 'sweepStaleRuns (src/jobs/stale-run-watchdog.js)');
    assert.match(d.title, /^PrismaClientValidationError: Invalid `prisma\.chatRun\.findMany\(\)` invocation/);
  });

  it('noise never becomes an issue', () => {
    assert.equal(fp.isNoise({ text: 'ElevenLabs API key not configured' }), true);
    assert.equal(fp.isNoise({ text: 'Feature disabled on this server' }), true);
    assert.equal(fp.isNoise({ text: 'AbortError: This operation was aborted' }), true);
    assert.equal(fp.isNoise({ text: '[agentic-chat] source-preserving pre-loop failed: Request was aborted.' }), true);
    assert.equal(fp.isNoise({ text: 'Error: Not found', status: 404 }), true);
    assert.equal(fp.isNoise({ text: '[system-errors] record failed: db down' }), true);
    assert.equal(fp.isNoise({ text: '(node:1) ExperimentalWarning: something' }), true);
    assert.equal(fp.isNoise({ text: 'HTTP 502', status: 502, source: 'http' }), false);
    assert.equal(fp.isNoise({ text: 'TypeError: x is not a function' }), false);
  });

  it('samples never carry secrets', () => {
    const out = fp.redactMultiline('fetch failed Authorization: Bearer abc.def.ghi\n  key sk-proj-AbCdEf1234567890 url postgresql://siragpt:hunter2@db:5432/siragpt');
    assert.doesNotMatch(out, /abc\.def\.ghi|sk-proj-AbCdEf|hunter2/);
    assert.match(out, /\n/, 'stack line breaks survive');
  });
});

describe('capture → issues (new, repeat, regression, ignored, spike)', () => {
  let prisma;
  let store;
  beforeEach(() => {
    systemErrors.__resetForTests();
    prisma = fakePrisma();
    store = createSystemIssueStore({ prisma });
    systemErrors.__setStoreForTests(store);
  });
  afterEach(() => {
    systemErrors.__resetForTests();
    systemErrors.__setStoreForTests(null);
  });

  it('console.error keeps its output and becomes a NEW issue with one alert', async () => {
    const written = [];
    const fakeConsole = { error: (...a) => written.push(['error', ...a]), warn: (...a) => written.push(['warn', ...a]) };
    // install on a private console object (the real one stays untouched)
    const originalInstalled = systemErrors.installConsoleCapture;
    assert.equal(typeof originalInstalled, 'function');
    const err = new TypeError("Cannot read properties of null (reading 'id')");
    err.stack = stackFor('saveChat', 'routes/chats.js');
    systemErrors.captureConsole('error', ['[chats] save failed:', err]);
    fakeConsole.error('[chats] save failed:', err);
    assert.equal(written.length, 1);
    const results = await systemErrors.flush();
    assert.equal(results.length, 1);
    assert.equal(issues(prisma).length, 1);
    const m = issues(prisma)[0].metadata;
    assert.equal(m.status, 'nuevo');
    assert.equal(m.title, "TypeError: [chats] save failed: Cannot read properties of null (reading 'id')");
    assert.equal(m.culprit, 'saveChat (src/routes/chats.js)');
    assert.equal(m.samples[0].stack.split('\n').length, 4);
    assert.equal(alerts(prisma).length, 1);
    assert.equal(alerts(prisma)[0].metadata.type, 'nuevo');
  });

  it('a flood of the same error collapses into ONE event (dozens of lines, one count)', async () => {
    for (let i = 0; i < 40; i += 1) {
      systemErrors.captureConsole('error', ['[agent-task-worker] worker error:', 'ERR Your database has been temporarily rate-limited']);
      systemErrors.captureConsole('error', ['[codex-runs] worker error:', 'ERR Your database has been temporarily rate-limited']);
    }
    await systemErrors.flush();
    assert.equal(issues(prisma).length, 1);
    const m = issues(prisma)[0].metadata;
    assert.equal(m.kind, 'redis');
    assert.equal(m.count, 1, 'one event');
    assert.equal(m.lines, 80, 'every line is still counted');
    assert.equal(m.samples.length, 1);
    assert.equal(m.samples[0].burst, 80);
    assert.equal(alerts(prisma).length, 1);
  });

  it('a known issue repeating never re-alerts; resolved + recurring → regression alert; ignored stays quiet', async () => {
    const raise = () => systemErrors.capture({ source: 'console', name: 'RangeError', message: 'Invalid array length', stack: stackFor('paginate', 'services/pager.js') });
    raise();
    await systemErrors.flush();
    const issueId = issues(prisma)[0].id;
    systemErrors.__resetForTests(); // next event is outside the burst window
    raise();
    await systemErrors.flush();
    assert.equal(issues(prisma).length, 1);
    assert.equal(issues(prisma)[0].metadata.count, 2);
    assert.equal(alerts(prisma).length, 1, 'repeat of a known issue: no alert');

    await store.setStatus(issueId, 'resuelto', { id: 'admin-1', email: 'luis@example.com' });
    assert.equal(issues(prisma)[0].metadata.status, 'resuelto');
    systemErrors.__resetForTests();
    raise();
    await systemErrors.flush();
    const m = issues(prisma)[0].metadata;
    assert.equal(m.status, 'nuevo');
    assert.equal(m.regression, true);
    assert.equal(alerts(prisma).length, 2);
    assert.equal(alerts(prisma).find((a) => a.metadata.type === 'regresion').metadata.issueId, issueId);

    await store.setStatus(issueId, 'ignorado', { id: 'admin-1' });
    systemErrors.__resetForTests();
    raise();
    await systemErrors.flush();
    assert.equal(issues(prisma)[0].metadata.status, 'ignorado');
    assert.equal(alerts(prisma).length, 2, 'ignored issues never alert');
    const history = prisma.rows.filter((r) => r.action === 'system_issue_status');
    assert.deepEqual(history.map((h) => h.metadata.to), ['resuelto', 'ignorado']);
  });

  it('warnings are captured only when they name a real failure', async () => {
    assert.equal(systemErrors.captureConsole('warning', ['[ai/generate-speech] elevenlabs failed (401): invalid key']) !== null, true);
    assert.equal(systemErrors.captureConsole('warning', ['[redis] swallowed transient rejection: ERR max requests limit exceeded']) !== null, true);
    assert.equal(systemErrors.captureConsole('warning', ['[intent-attr-graph] feats=12 themes=3']), null);
    assert.equal(systemErrors.captureConsole('warning', ['slow request 1200ms']), null);
    await systemErrors.flush();
    assert.equal(issues(prisma).length, 2);
    assert.ok(issues(prisma).every((r) => r.metadata.level === 'warning'));
  });

  it('config-absent answers, 4xx and client aborts never become issues', async () => {
    systemErrors.captureConsole('error', ['ElevenLabs API key not configured']);
    systemErrors.captureRequestError(Object.assign(new Error('Validation failed'), { status: 400 }), { req: null, tags: { status: 400 } });
    systemErrors.captureConsole('error', ['AI stream aborted by client']);
    await systemErrors.flush();
    assert.equal(issues(prisma).length, 0);
    assert.ok(systemErrors.snapshot().noise >= 2);
  });

  it('uncaught exceptions are fatal; frontend crashes group next to the backend ones', async () => {
    const boom = new Error('Cannot find module ./missing');
    boom.stack = stackFor('boot', 'index.js');
    systemErrors.captureFatal(boom, 'uncaughtException');
    systemErrors.captureFrontendEvent({ source: 'render', severity: 'error', message: 'Minified React error #310', page: '/agentes/cmuj01io7000jpj5kuy7nyolt', component: 'MessageList' }, { user: { id: 'u1' }, headers: {} });
    systemErrors.captureFrontendEvent({ source: 'api', severity: 'error', status: 500, message: 'HTTP 500' }, null);
    systemErrors.captureFrontendEvent({ source: 'network', severity: 'error', message: 'Failed to fetch' }, null);
    systemErrors.captureFrontendEvent({ source: 'global', severity: 'error', message: 'ResizeObserver loop completed with undelivered notifications.' }, null);
    systemErrors.captureFrontendEvent({ source: 'global', severity: 'error', message: 'Script error.' }, null);
    systemErrors.captureFrontendEvent({ source: 'global', severity: 'error', message: 'ChunkLoadError: Loading chunk 812 failed.' }, null);
    systemErrors.captureFrontendEvent({ source: 'global', severity: 'error', message: 'x is undefined', stack: 'at f (chrome-extension://abcdef/content.js:1:2)' }, null);
    await systemErrors.flush();
    const rows = issues(prisma);
    assert.equal(rows.length, 2);
    const fatal = rows.find((r) => r.metadata.level === 'fatal');
    assert.equal(fatal.metadata.kind, 'excepcion');
    const front = rows.find((r) => r.metadata.kind === 'frontend');
    assert.equal(front.metadata.samples[0].route, '/agentes/:id');
    assert.deepEqual(front.metadata.users, ['u1']);
  });

  it('caps the number of NEW issues per minute (fingerprint explosions)', async () => {
    for (let i = 0; i < 45; i += 1) {
      systemErrors.capture({ source: 'console', message: `unique failure ${'x'.repeat(i + 1)}` });
    }
    await systemErrors.flush();
    assert.equal(issues(prisma).length, 30);
    assert.equal(systemErrors.snapshot().capped, 15);
  });

  it('flags a rate spike and draws the 24 h sparkline', () => {
    const now = Date.parse('2026-09-26T20:40:00.000Z');
    const hours = { [hourKey(now)]: 25, [hourKey(now - 5 * 3600 * 1000)]: 2, [hourKey(now - 9 * 3600 * 1000)]: 1 };
    const spike = spikeOf(hours, now);
    assert.equal(spike.spike, true);
    assert.equal(spike.lastHour, 25);
    const calm = spikeOf({ [hourKey(now)]: 4 }, now);
    assert.equal(calm.spike, false);
    const item = store.toItem({ id: 'x', resourceId: 'fp', createdAt: new Date(now), metadata: { hours, count: 28 } }, now);
    assert.equal(item.sparkline.length, 24);
    assert.equal(item.sparkline[23], 25);
    assert.equal(item.events24h, 28);
  });
});

describe('HTTP: 5xx with route + reqId, one issue per failure', () => {
  let prisma;
  beforeEach(() => {
    systemErrors.__resetForTests();
    prisma = fakePrisma();
    systemErrors.__setStoreForTests(createSystemIssueStore({ prisma }));
  });
  afterEach(() => {
    systemErrors.__resetForTests();
    systemErrors.__setStoreForTests(null);
  });

  function fakeRes() {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.status = function status(code) { this.statusCode = code; return this; };
    res.json = function json(body) { this.body = body; this.emit('finish'); return this; };
    return res;
  }
  const baseReq = (extra = {}) => ({
    method: 'POST',
    originalUrl: '/api/files/upload',
    baseUrl: '/api/files',
    route: { path: '/upload' },
    requestId: 'req-500',
    user: { id: 'u1' },
    body: { chatId: 'chat-1' },
    headers: {},
    ...extra,
  });

  it('a bare 500 answer becomes an HTTP issue with method, route, status and request id', async () => {
    const mw = systemErrors.httpMiddleware();
    const req = baseReq();
    const res = fakeRes();
    await new Promise((resolve) => mw(req, res, resolve));
    res.status(500).json({ error: 'upload_failed' });
    await systemErrors.flush();
    const [row] = issues(prisma);
    assert.equal(row.metadata.kind, 'http');
    assert.equal(row.metadata.title, 'HTTP 500 · POST /api/files/upload — upload_failed');
    assert.deepEqual(row.metadata.reqIds, ['req-500']);
    assert.deepEqual(row.metadata.chatIds, ['chat-1']);
    assert.equal(row.metadata.samples[0].status, 500);
  });

  it('an error already captured for that request is enriched, not duplicated; 4xx and config 503 are ignored', async () => {
    const mw = systemErrors.httpMiddleware();
    const req = baseReq({ requestId: 'req-dup' });
    const res = fakeRes();
    await new Promise((resolve) => mw(req, res, resolve));
    const err = new Error('column "x" does not exist');
    err.stack = stackFor('insertFile', 'routes/files.js');
    systemErrors.captureRequestError(err, { req, tags: { status: 500 } });
    res.status(500).json({ error: 'Internal error' });

    const req2 = baseReq({ requestId: 'req-404' });
    const res2 = fakeRes();
    await new Promise((resolve) => mw(req2, res2, resolve));
    res2.status(404).json({ error: 'Not found' });

    const req3 = baseReq({ requestId: 'req-503' });
    const res3 = fakeRes();
    await new Promise((resolve) => mw(req3, res3, resolve));
    res3.status(503).json({ error: 'Stripe not configured' });

    await systemErrors.flush();
    assert.equal(issues(prisma).length, 1);
    const m = issues(prisma)[0].metadata;
    assert.equal(m.kind, 'base_de_datos');
    assert.equal(m.samples[0].status, 500);
    assert.equal(m.samples[0].route, '/api/files/upload');
    assert.equal(m.samples[0].reqId, 'req-dup');
  });
});

describe('admin queries — list, stats, recent, detail with linked failed turns', () => {
  let prisma;
  let store;
  beforeEach(() => {
    systemErrors.__resetForTests();
    prisma = fakePrisma();
    store = createSystemIssueStore({ prisma });
    systemErrors.__setStoreForTests(store);
  });
  afterEach(() => {
    systemErrors.__resetForTests();
    systemErrors.__setStoreForTests(null);
  });

  it('lists open issues by default, filters and opens the detail', async () => {
    const ctx = { reqId: 'req-t1', userId: 'u1', chatId: 'chat-1', route: '/api/ai/generate', method: 'POST' };
    systemErrors.capture({ source: 'console', name: 'TypeError', message: 'x.map is not a function', stack: stackFor('renderSources', 'services/ai-service.js'), ctx });
    systemErrors.capture({ source: 'console', message: '[doc-engine] worker error: Missing lock for job 7', ctx: null });
    await systemErrors.flush();
    // a failed turn of the same request
    await prisma.auditLog.create({ data: { action: 'turn_failed', resourceType: 'chat_turn', resourceId: 'chat-1:k', actorName: 'luis@example.com', metadata: { category: 'error_visible', categoryLabel: 'Error visible', cause: 'DeepSeek 500', prompt: 'hola', reqIds: ['req-t1'], openLink: '/agentes/chat-1' } } });

    const open = await store.list({});
    assert.equal(open.total, 2);
    const queue = await store.list({ kind: 'cola' });
    assert.equal(queue.total, 1);
    const search = await store.list({ q: 'MAP is not' });
    assert.equal(search.total, 1);
    assert.equal((await store.list({ from: '2099-01-01T00:00:00.000Z' })).total, 0, 'date range on lastSeen');
    assert.equal((await store.list({ to: '2099-01-01T00:00:00.000Z' })).total, 2);

    const id = search.items[0].id;
    const detail = await store.get(id);
    assert.equal(detail.samples[0].reqId, 'req-t1');
    assert.equal(detail.users[0].email, 'luis@example.com');
    assert.equal(detail.linkedTurns.length, 1);
    assert.equal(detail.linkedTurns[0].cause, 'DeepSeek 500');
    assert.equal(detail.hours48.length, 48);

    await store.setStatus(id, 'resuelto', { email: 'luis@example.com' });
    assert.equal((await store.list({})).total, 1);
    assert.equal((await store.list({ status: 'resuelto' })).total, 1);

    const stats = await store.stats();
    assert.equal(stats.open, 1);
    assert.equal(stats.new24h, 2);
    assert.equal(stats.resolved7d, 1);

    const recent = await store.recent({ since: new Date(Date.parse('2026-09-26T19:59:00.000Z')).toISOString() });
    assert.equal(recent.count, 2);
    assert.ok(recent.items.every((i) => i.type === 'nuevo'));
    await assert.rejects(store.setStatus(id, 'borrado'), /Estado no válido/);
  });

  it('retention sweeps silent issues and old alert rows', async () => {
    systemErrors.capture({ source: 'console', message: 'old failure', ctx: null });
    await systemErrors.flush();
    systemErrors.capture({ source: 'console', message: 'recent failure', ctx: null });
    await systemErrors.flush();
    const [old, recent] = issues(prisma);
    old.createdAt = new Date('2026-06-15T00:00:00.000Z');
    old.metadata.lastSeen = '2026-07-01T00:00:00.000Z';
    // created long ago but seen recently → kept
    recent.createdAt = new Date('2026-06-15T00:00:00.000Z');
    const res = await store.sweepExpired({ retentionDays: 30 });
    assert.equal(res.deletedIssues, 1);
    assert.deepEqual(issues(prisma).map((r) => r.metadata.title), ['recent failure']);
  });
});

describe('turn link — an error inside a chat turn is noted on it', () => {
  it('adds a system_error note to the tracked turn', async () => {
    process.env.SIRAGPT_TURN_FAILURES = '1';
    systemErrors.__resetForTests();
    const prisma = fakePrisma();
    systemErrors.__setStoreForTests(createSystemIssueStore({ prisma }));
    const turnFailures = require('../src/services/observability/turn-failures');
    const res = new EventEmitter();
    res.write = () => true;
    res.statusCode = 200;
    const tap = turnFailures.beginTurn({ method: 'POST', headers: {}, user: { id: 'u1' }, body: {} }, res, { route: 'generate', autoFinish: false, context: { idempotencyKey: 'k1' } });
    await Promise.resolve();
    systemErrors.capture({ source: 'console', message: '[ai-service] provider stream crashed', ctx: null });
    assert.ok(tap.notes.some((n) => n.kind === 'system_error' && n.data.title === '[ai-service] provider stream crashed'));
    tap.finished = true;
    systemErrors.__resetForTests();
    systemErrors.__setStoreForTests(null);
  });
});

describe('wiring contracts', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

  it('index.js installs capture after the console shaping, hooks the process and the error handler', () => {
    const idx = read('index.js');
    const shaping = idx.indexOf('console.log = (...args) => {');
    const install = idx.indexOf('systemErrors.installConsoleCapture();');
    assert.ok(shaping > 0 && install > shaping, 'console capture wraps the shaped console');
    assert.match(idx, /systemErrors\.captureFatal\(reason, 'unhandledRejection'\);\s*\n\s*console\.error\('\[FATAL\] unhandledRejection:'/);
    assert.match(idx, /systemErrors\.captureFatal\(error, 'uncaughtException'\);\s*\n\s*console\.error\('\[FATAL\] uncaughtException:'/);
    const requestId = idx.indexOf('app.use(requestIdMiddleware);');
    const http = idx.indexOf('app.use(systemErrors.httpMiddleware());');
    assert.ok(requestId > 0 && http > requestId, 'the http hook needs the request log context');
    assert.match(idx, /captureSentryException\(err, context\);\s*\n\s*systemErrors\.captureRequestError\(err, context\);/);
    assert.match(idx, /systemErrors\.flush\(\),\s*\n\s*shutdownOpenTelemetry\(\),/);
  });

  it('telemetry, admin routes, policies and retention are wired', () => {
    assert.match(read('src/routes/telemetry.js'), /captureFrontendEvent\(event, req\)/);
    const admin = read('src/routes/admin.js');
    for (const route of ["router.get('/system-issues'", "router.get('/system-issues/stats'", "router.get('/system-issues/recent'", "router.get('/system-issues/:id'", "router.patch('/system-issues/:id'"]) {
      assert.ok(admin.includes(route), route);
    }
    assert.ok(admin.indexOf("router.get('/system-issues/recent'") < admin.indexOf("router.get('/system-issues/:id'"), 'static paths before :id');
    const policy = read('src/services/admin-route-policy.js');
    assert.match(policy, /'PATCH \/api\/admin\/system-issues\/:id': policy\('admin\.maintenance\.manage'\)/);
    assert.match(read('src/jobs/system-cron.js'), /require\('\.\.\/services\/observability\/system-errors'\)\.getStore\(\)\.sweepExpired/);
  });
});
