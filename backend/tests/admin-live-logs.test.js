'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { redactText } = require('../src/services/observability/live-logs/redact');
const { classifyLine } = require('../src/services/observability/live-logs/classify');
const capture = require('../src/services/observability/live-logs/capture');
const { LiveLogStore, idGreater } = require('../src/services/observability/live-logs/store');
const loggerCtx = require('../src/utils/logger');
const generation = require('../src/services/observability/generation-outcome');
const policy = require('../src/services/admin-route-policy');

// ── Redaction ────────────────────────────────────────────────────────────

const SECRET_CASES = [
  ['openai key', 'calling with sk-proj-AbCdEf0123456789XYZabcdEF', 'AbCdEf0123456789'],
  ['deepseek key', 'key=sk-7f3c2a9b8e1d4c6f0a5b7e9d', '7f3c2a9b8e1d'],
  ['anthropic key', 'sk-ant-api03-AAAABBBBCCCCDDDDEEEE', 'AAAABBBBCCCC'],
  ['xai key', 'Authorization: Bearer xai-QWERTYUIOPASDFGHJKLZ', 'QWERTYUIOP'],
  ['bearer', 'headers {"authorization":"Bearer abc.def.ghijklmnop"}', 'abc.def.ghijklmnop'],
  ['jwt', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N', 'dozjgNryP4J3'],
  ['postgres url', 'DATABASE_URL=postgresql://siragpt:S3cretPass@db:5432/siragpt', 'S3cretPass'],
  ['redis url', 'connect redis://:r3dPassw0rd@redis:6379/0 failed', 'r3dPassw0rd'],
  ['cookie header', 'cookie: connect.sid=s%3Aabc123def456; csrf_token=zzz999', 'abc123def456'],
  ['api_key param', 'GET /x?api_key=supersecretvalue123&q=1', 'supersecretvalue123'],
  ['json password', '{"email":"a@b.co","password":"hunter2hunter2"}', 'hunter2hunter2'],
  ['google key', 'AIzaSyA1234567890abcdefghijklmnopqrstuv', '1234567890abcdef'],
  ['groq key', 'gsk_1234567890abcdefghijklmnop', '1234567890abcdef'],
  ['encrypted conn', 'apiKey stored enc:v1:0a1b2c3d4e5f6a7b8c9d:ffeeddccbbaa', '0a1b2c3d4e5f'],
  ['pem', '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----', 'MIIEvQIBADAN'],
  ['fal key', 'FAL_KEY=0f8fad5b-d9cb-469f-a165-70867728950e:8d2a0b5c0e7f4a1b9c3d2e1f0a9b8c7d', '8d2a0b5c0e7f'],
  ['sandbox key env', 'SANDBOX_API_KEY=9b1deb4d3b7d4bad9bdd2b0d7b3dcb6d', '9b1deb4d3b7d'],
  ['meta key', 'using LLM|ABCDEFGHIJKLMNOPQRSTUVWX123', 'ABCDEFGHIJKLMNOP'],
];

for (const [name, input, secret] of SECRET_CASES) {
  test(`redaction removes ${name}`, () => {
    const out = redactText(input);
    assert.ok(!out.includes(secret), `${name} leaked: ${out}`);
    assert.match(out, /REDACTED/);
  });
}

test('redaction keeps benign operational text intact', () => {
  const benign = [
    '{"max_tokens":900,"temperature":0}',
    '[file-status] {"event":"file_processing_stage","error":null,"stage":"ready"}',
    'user infosiragpt@gmail.com POST /api/ai/generate → 200 (812 ms)',
    '[doc-routing] {"entry":"doc_generate","path":"agent_runner"}',
    'prompt_tokens=120 completion_tokens=40',
  ];
  for (const line of benign) assert.equal(redactText(line), line);
});

test('redaction caps huge lines', () => {
  const out = redactText('x'.repeat(100_000));
  assert.ok(out.length < 17_000);
  assert.match(out, /truncado/);
});

// ── Level / source inference ─────────────────────────────────────────────

test('level follows the console method', () => {
  assert.equal(classifyLine({ text: 'hello', method: 'console.error' }).level, 'error');
  assert.equal(classifyLine({ text: 'hello', method: 'console.warn' }).level, 'warn');
  assert.equal(classifyLine({ text: 'hello', method: 'console.log' }).level, 'info');
  assert.equal(classifyLine({ text: 'hello', method: 'console.debug' }).level, 'debug');
});

test('content upgrades plain lines to error / fatal / warn', () => {
  assert.equal(classifyLine({ text: 'Image file not found: /app/uploads/x.png — Error: ENOENT', method: 'console.log' }).level, 'error');
  assert.equal(classifyLine({ text: 'TypeError: cannot read properties of undefined\n    at foo (/app/src/x.js:1:2)', method: 'console.log' }).level, 'error');
  assert.equal(classifyLine({ text: '[FATAL] unhandledRejection: boom', method: 'console.log' }).level, 'fatal');
  assert.equal(classifyLine({ text: '[fileProcessor] vision fallback failed: 429 status code', method: 'console.log' }).level, 'warn');
  assert.equal(classifyLine({ text: 'AI stream aborted by client for provider: xAI.', method: 'console.log' }).level, 'warn');
  assert.equal(classifyLine({ text: '[file-status] {"stage":"ready","error":null}', method: 'console.log' }).level, 'info');
  assert.equal(classifyLine({ text: 'Trace: here\n    at x (y.js:1:1)', method: 'console.trace' }).level, 'debug');
});

test('BullMQ worker errors are errors from a worker source', () => {
  const e = classifyLine({ text: "[agent-task-worker] worker error: ERR Your database has been temporarily rate-limited", method: 'console.error' });
  assert.equal(e.level, 'error');
  assert.equal(e.source, 'worker:agent-task-worker');
  assert.equal(e.tag, 'agent-task-worker');
});

test('structured JSON lines: pino levels, HTTP status and summary', () => {
  const pino = classifyLine({ text: JSON.stringify({ level: 50, time: 1, msg: 'boom', req: { id: 'r-1' } }), method: 'pino' });
  assert.equal(pino.level, 'error');
  assert.equal(pino.jsonCtx.reqId, 'r-1');
  const access = classifyLine({ text: JSON.stringify({ ts: 'x', level: 'info', method: 'POST', path: '/api/ai/generate', status: 502, durMs: 81770, reqId: 'abc', userId: 'u1' }), method: 'stdout' });
  assert.equal(access.level, 'error');
  assert.equal(access.status, 502);
  assert.match(access.msg, /POST \/api\/ai\/generate → 502 \(81770 ms\)/);
  assert.deepEqual(access.jsonCtx, { reqId: 'abc', userId: 'u1' });
  const ok = classifyLine({ text: JSON.stringify({ level: 30, msg: 'request completed', req: { method: 'GET', url: '/api/health' }, res: { statusCode: 200 } }), method: 'pino' });
  assert.equal(ok.level, 'info');
});

test('a multi-line dump stays ONE event (first line = msg, all = body)', () => {
  const dump = [
    'ReplyError: ERR Your database has been temporarily rate-limited',
    '    at parseError (/app/node_modules/redis-parser/lib/parser.js:179:12)',
    "  command: { name: 'evalsha', args: [ 'bull:siragpt-agent-runner:wait' ] }",
  ].join('\n');
  const e = classifyLine({ text: dump, method: 'console.error' });
  assert.equal(e.level, 'error');
  assert.equal(e.msg, 'ReplyError: ERR Your database has been temporarily rate-limited');
  assert.match(e.body, /bull:siragpt-agent-runner:wait/);
});

// ── Capture + AsyncLocalStorage context ──────────────────────────────────

function withSink(fn) {
  const state = capture._state;
  const prev = { sink: state.sink, enabled: state.enabled, allowed: state.contextAllowed };
  const events = [];
  state.sink = (e) => { events.push(e); return e; };
  state.enabled = true;
  state.contextAllowed = true;
  return Promise.resolve(fn(events)).finally(() => {
    state.sink = prev.sink;
    state.enabled = prev.enabled;
    state.contextAllowed = prev.allowed;
  });
}

test('captured lines carry request context across awaits', async () => {
  await withSink(async (events) => {
    const req = {
      method: 'POST',
      baseUrl: '/api/ai',
      route: { path: '/generate' },
      originalUrl: '/api/ai/generate?token=abc',
      user: { id: 'user-1', email: 'luis@example.com' },
      body: { chatId: 'chat-9', prompt: 'hola' },
    };
    await loggerCtx.runWithContext({ reqId: 'req-123' }, async () => {
      loggerCtx.setContextField('__liveLogsReq', req);
      await new Promise((r) => setTimeout(r, 5));
      capture.captureText('📸 Processing 1 image(s) for vision API', 'console.log');
      await Promise.resolve();
      capture.captureText('Image file not found: /app/uploads/x.png', 'console.error');
    });
    assert.equal(events.length, 2);
    for (const e of events) {
      assert.equal(e.reqId, 'req-123');
      assert.equal(e.userId, 'user-1');
      assert.equal(e.email, 'luis@example.com');
      assert.equal(e.chatId, 'chat-9');
      assert.equal(e.route, 'POST /api/ai/generate');
    }
    assert.equal(events[1].level, 'error');
  });
});

test('worker context (runWithLogContext) tags queue + job', async () => {
  const liveLogs = require('../src/services/observability/live-logs');
  await withSink(async (events) => {
    await liveLogs.runWithLogContext({ queue: 'siragpt-agent-runner', jobId: 'job-7', userId: 'u2' }, async () => {
      await Promise.resolve();
      capture.captureText('processing job', 'console.log');
    });
    assert.equal(events[0].source, 'worker:siragpt-agent-runner');
    assert.equal(events[0].jobId, 'job-7');
    assert.equal(events[0].userId, 'u2');
  });
});

test('stream hook passes writes through unchanged and captures them once', async () => {
  await withSink(async (events) => {
    const written = [];
    const fake = { write(chunk, enc, cb) { written.push(chunk); if (typeof cb === 'function') cb(); return true; } };
    capture._hookStream(fake, 'stderr');
    const ret = fake.write('[agent-task-worker] worker error: ERR boom\n');
    assert.equal(ret, true);
    assert.deepEqual(written, ['[agent-task-worker] worker error: ERR boom\n']);
    assert.equal(events.length, 1);
    assert.equal(events[0].level, 'error');
    assert.equal(events[0].via, 'stderr');
    // Secrets never reach the sink.
    fake.write('retrying with key sk-live-ABCDEFGHIJKLMNOPQRST\n');
    assert.ok(!JSON.stringify(events[1]).includes('ABCDEFGHIJKLMNOP'));
    // Our own notes are never re-captured.
    fake.write('[live-logs] note\n');
    assert.equal(events.length, 2);
  });
});

test('pino tap returns the line unchanged and captures it', async () => {
  await withSink(async (events) => {
    const line = `${JSON.stringify({ level: 40, msg: 'slow provider', reqId: 'r-9' })}\n`;
    assert.equal(capture.tapPinoLine(line), line);
    assert.equal(events[0].level, 'warn');
    assert.equal(events[0].reqId, 'r-9');
  });
});

test('real pino: each line is captured exactly once on both write paths', async () => {
  const pino = require('pino');
  await withSink(async (events) => {
    // Path 1 — stdout hooked before pino loaded: pino writes through the
    // hooked stream AND calls the streamWrite tap. Must stay ONE event.
    const written = [];
    const hookedDest = { write(s) { written.push(s); return true; } };
    capture._hookStream(hookedDest, 'stdout');
    const logger = pino({ hooks: { streamWrite: capture.tapPinoLine } }, hookedDest);
    logger.error({ reqId: 'r-7', apiKey: 'sk-live-ZZZZYYYYXXXXWWWWVVVV' }, 'provider exploded');
    logger.info('all good');
    assert.equal(written.length, 2, 'pino output itself is untouched');
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((e) => e.level), ['error', 'info']);
    assert.equal(events[0].via, 'pino');
    assert.equal(events[0].reqId, 'r-7');
    assert.ok(!JSON.stringify(events).includes('ZZZZYYYYXXXX'));
    // Path 2 — SonicBoom-style destination that bypasses the hooked stream:
    // only the tap sees it.
    const plainDest = { write() { return true; } };
    const logger2 = pino({ hooks: { streamWrite: capture.tapPinoLine } }, plainDest);
    logger2.warn('slow provider');
    assert.equal(events.length, 3);
    assert.equal(events[2].level, 'warn');
  });
});

// ── Store ───────────────────────────────────────────────────────────────

function ev(over = {}) {
  return { level: 'info', source: 'backend', msg: 'hello', ...over };
}

test('ring buffer: filters, afterId and ordering', () => {
  let t = 1_000;
  const store = new LiveLogStore({ env: {}, now: () => t });
  const a = store.push(ev({ msg: 'uno', ts: (t += 10) }));
  store.push(ev({ msg: 'dos error', level: 'error', ts: (t += 10), email: 'luis@x.com', reqId: 'r1' }));
  store.push(ev({ msg: 'tres', level: 'warn', ts: (t += 10), source: 'worker:codex-runs' }));
  assert.deepEqual(store.recent({}).map((e) => e.msg), ['uno', 'dos error', 'tres']);
  assert.deepEqual(store.recent({ minLevel: 'warn' }).map((e) => e.msg), ['dos error', 'tres']);
  assert.deepEqual(store.recent({ user: 'luis' }).map((e) => e.msg), ['dos error']);
  assert.deepEqual(store.recent({ reqId: 'r1' }).map((e) => e.msg), ['dos error']);
  assert.deepEqual(store.recent({ source: 'worker' }).map((e) => e.msg), ['tres']);
  assert.deepEqual(store.recent({ q: 'ERROR' }).map((e) => e.msg), ['dos error']);
  assert.deepEqual(store.recent({}, { afterId: a.id }).map((e) => e.msg), ['dos error', 'tres']);
});

test('ids are monotonic even within the same millisecond', () => {
  const store = new LiveLogStore({ env: {}, now: () => 5 });
  const x = store.push(ev({ ts: 5, msg: 'a' }));
  const y = store.push(ev({ ts: 5, msg: 'b' }));
  const z = store.push(ev({ ts: 4, msg: 'c' }));
  assert.ok(idGreater(y.id, x.id));
  assert.ok(idGreater(z.id, y.id));
});

test('floods of the same line collapse into one event with a repeat counter', () => {
  let t = 10_000;
  const store = new LiveLogStore({ env: {}, now: () => t });
  const repeats = [];
  store.bus.on('repeat', (r) => repeats.push(r));
  const first = store.push(ev({ level: 'error', msg: '[codex-runs] worker error: ERR rate-limited 1790467141751', ts: t }));
  store.push(ev({ level: 'error', msg: '[codex-runs] worker error: ERR rate-limited 1790467145667', ts: (t += 500) }));
  store.push(ev({ level: 'error', msg: '[codex-runs] worker error: ERR rate-limited 1790467146000', ts: (t += 500) }));
  assert.equal(store.recent({}).length, 1);
  assert.equal(first.repeat, 3);
  assert.equal(repeats.length, 2);
  store.push(ev({ level: 'error', msg: '[codex-runs] worker error: ERR rate-limited 1', ts: (t += 10_000) }));
  assert.equal(store.recent({}).length, 2);
});

function fakeRedis() {
  const streams = { };
  const lists = { };
  const calls = [];
  const client = new EventEmitter();
  const exec = (ops) => ops.map(([name, args]) => {
    calls.push([name, ...args]);
    try {
      if (name === 'xadd') {
        const [key, , , , id, , data] = args;
        (streams[key] = streams[key] || []).push([id, ['d', data]]);
        return [null, id];
      }
      if (name === 'rpush') { (lists[args[0]] = lists[args[0]] || []).push(args[1]); return [null, 1]; }
      if (name === 'xrange') {
        const [key, from] = args;
        return [null, (streams[key] || []).filter(([id]) => id === from)];
      }
      return [null, 'OK'];
    } catch (err) {
      return [err];
    }
  });
  client.pipeline = () => {
    const ops = [];
    const p = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'exec') return async () => exec(ops);
        return (...args) => { ops.push([prop, args]); return p; };
      },
    });
    return p;
  };
  client.lrange = async (key) => lists[key] || [];
  client.xrevrange = async (key, end, start, _c, count) => {
    const all = [...(streams[key] || [])].reverse();
    const bound = end.startsWith('(') ? end.slice(1) : null;
    const out = bound ? all.filter(([id]) => idGreater(bound, id)) : all;
    return out.slice(0, count);
  };
  client.info = async () => 'used_memory:1000\r\nmaxmemory:536870912\r\n';
  client.xtrim = async (...args) => { calls.push(['xtrim', ...args]); return 0; };
  client.disconnect = () => {};
  return { client, streams, lists, calls };
}

test('Redis flush: all stream, error stream for warn+, per-request index', async () => {
  const fake = fakeRedis();
  let t = 50_000;
  const store = new LiveLogStore({ env: {}, now: () => t, redisFactory: () => fake.client });
  store.start();
  store.redisReady = true;
  store.push(ev({ msg: 'ok line', reqId: 'req-a', ts: (t += 1) }));
  store.push(ev({ msg: 'bad line', level: 'error', reqId: 'req-a', ts: (t += 1) }));
  await store.flush();
  assert.equal(fake.streams['siragpt:logs:all'].length, 2);
  assert.equal(fake.streams['siragpt:logs:err'].length, 1);
  assert.equal(fake.lists['siragpt:logs:req:req-a'].length, 2);
  const lines = await store.requestLines('req-a');
  assert.deepEqual(lines.map((l) => l.msg), ['ok line', 'bad line']);
  const hist = await store.search({ minLevel: 'error' }, { limit: 10 });
  assert.equal(hist.stream, 'errors');
  assert.deepEqual(hist.lines.map((l) => l.msg), ['bad line']);
  store.stop();
});

test('request trail survives an expired index by scanning the streams', async () => {
  const fake = fakeRedis();
  let t = 70_000;
  const store = new LiveLogStore({ env: {}, now: () => t, redisFactory: () => fake.client });
  store.start();
  store.redisReady = true;
  store.push(ev({ msg: 'old turn start', reqId: 'req-old', ts: (t += 1) }));
  store.push(ev({ msg: 'old turn failed', level: 'error', reqId: 'req-old', ts: (t += 1) }));
  await store.flush();
  delete fake.lists['siragpt:logs:req:req-old'];
  store.ring = new Array(store.opts.ringMax);
  store.ringSize = 0;
  const lines = await store.requestLines('req-old');
  store.stop();
  assert.deepEqual(lines.map((l) => l.msg), ['old turn start', 'old turn failed']);
});

test('memory guard pauses persistence before Redis (shared with BullMQ) fills up', async () => {
  const fake = fakeRedis();
  fake.client.info = async () => 'used_memory:400000000\r\nmaxmemory:536870912\r\n';
  const store = new LiveLogStore({ env: {}, redisFactory: () => fake.client });
  store.start();
  store.redisReady = true;
  const state = await store.checkMemory();
  store.stop();
  assert.equal(state.paused, true);
  assert.equal(store.paused, true);
  assert.ok(fake.calls.some((c) => c[0] === 'xtrim'));
  store.push(ev({ msg: 'still in memory' }));
  assert.equal(await store.flush(), 0);
  assert.equal(store.recent({}).length >= 1, true);
});

// ── SSE live endpoint ───────────────────────────────────────────────────

function fakeSse(query = {}) {
  const req = new EventEmitter();
  req.query = query;
  req.setTimeout = () => {};
  const res = new EventEmitter();
  res.headers = {};
  res.chunks = [];
  res.statusCode = 200;
  res.status = (c) => { res.statusCode = c; return res; };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.flushHeaders = () => {};
  res.write = (c) => { res.chunks.push(c); return true; };
  res.json = (b) => { res.body = b; return res; };
  res.writableEnded = false;
  return { req, res };
}

function sseEvents(res) {
  return res.chunks.join('').split('\n\n').filter(Boolean).map((block) => {
    const ev = /^event: (.+)$/m.exec(block);
    const data = /^data: (.+)$/m.exec(block);
    return { event: ev && ev[1], data: data ? JSON.parse(data[1]) : null };
  });
}

test('live SSE: backfill, then live tail filtered by level, cleanup on close', async () => {
  const liveLogs = require('../src/services/observability/live-logs');
  const routes = require('../src/routes/admin-live-logs');
  const store = liveLogs.getStore();
  store.push(ev({ msg: 'old info' }));
  store.push(ev({ msg: 'old error', level: 'error' }));
  const { req, res } = fakeSse({ level: 'error', backfill: '50' });
  await routes.live(req, res);
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.match(res.headers['cache-control'], /no-transform/);
  let events = sseEvents(res);
  assert.equal(events[0].event, 'hello');
  const backfill = events.find((e) => e.event === 'backfill');
  assert.ok(backfill.data.some((l) => l.msg === 'old error'));
  assert.ok(!backfill.data.some((l) => l.msg === 'old info'));
  store.push(ev({ msg: 'new info' }));
  store.push(ev({ msg: 'new error', level: 'error' }));
  await new Promise((r) => setTimeout(r, 450));
  events = sseEvents(res);
  const live = events.filter((e) => e.event === 'lines').flatMap((e) => e.data);
  assert.deepEqual(live.map((l) => l.msg), ['new error']);
  assert.equal(routes._activeClients.size >= 1, true);
  req.emit('close');
  assert.equal(store.bus.listenerCount('line'), 0);
});

test('request endpoint validates the id and returns ordered lines + summary', async () => {
  const liveLogs = require('../src/services/observability/live-logs');
  const routes = require('../src/routes/admin-live-logs');
  const store = liveLogs.getStore();
  store.push(ev({ msg: 'turn start', reqId: 'turn-42', email: 'luis@x.com', route: 'POST /api/ai/generate' }));
  store.push(ev({ msg: 'Image file not found', level: 'error', reqId: 'turn-42' }));
  const bad = fakeSse();
  bad.req.params = { reqId: 'bad id with spaces' };
  await routes.request(bad.req, bad.res);
  assert.equal(bad.res.statusCode, 400);
  const good = fakeSse();
  good.req.params = { reqId: 'turn-42' };
  await routes.request(good.req, good.res);
  assert.deepEqual(good.res.body.lines.map((l) => l.msg), ['turn start', 'Image file not found']);
  assert.equal(good.res.body.summary.errors, 1);
  assert.deepEqual(good.res.body.summary.users, ['luis@x.com']);
});

test('the three endpoints are admin-only (audit.read) through the route policy', () => {
  for (const p of ['/api/admin/logs/live', '/api/admin/logs/search', '/api/admin/logs/request/abc']) {
    const matched = policy.matchAdminRoutePolicy('GET', p);
    assert.ok(matched, `${p} must be mapped`);
    assert.equal(matched.permission, 'audit.read');
  }
});

// ── Generation outcome evidence ─────────────────────────────────────────

function recordingLogger() {
  const lines = [];
  const mk = (lvl) => (text) => lines.push({ lvl, text });
  return { lines, logger: { error: mk('error'), warn: mk('warn'), log: mk('log') } };
}

test('logGenerationOutcome: failure keeps the prompt, success does not', () => {
  const { lines, logger } = recordingLogger();
  const env = { SIRAGPT_GENERATION_LOG: '1' };
  generation.logGenerationOutcome({ kind: 'image', ok: false, code: 'E_PROVIDER', error: '429 rate limit', provider: 'xai', model: 'grok-2-image', prompt: 'un gato astronauta', durationMs: 12300 }, { env, logger });
  generation.logGenerationOutcome({ kind: 'image', ok: true, provider: 'xai', model: 'grok-2-image', prompt: 'un gato astronauta', durationMs: 8000 }, { env, logger });
  assert.equal(lines[0].lvl, 'error');
  assert.match(lines[0].text, /^\[generation\] image falló · xai\/grok-2-image · 12\.3 s · E_PROVIDER: 429 rate limit/);
  assert.match(lines[0].text, /"prompt":"un gato astronauta"/);
  assert.equal(lines[1].lvl, 'log');
  assert.ok(!lines[1].text.includes('gato'));
});

test('image engine instrumentation flags a blank image as degenerate', async () => {
  const sharp = require('sharp');
  const blank = await sharp({ create: { width: 256, height: 256, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
  const info = await generation.inspectImageBuffer(blank);
  assert.equal(info.degenerate, 'imagen en blanco o de un solo color');
  const noisy = Buffer.alloc(128 * 128 * 3);
  for (let i = 0; i < noisy.length; i += 1) noisy[i] = (i * 7919) % 256;
  const real = await sharp(noisy, { raw: { width: 128, height: 128, channels: 3 } }).png().toBuffer();
  assert.equal((await generation.inspectImageBuffer(real)).degenerate, null);
  assert.equal((await generation.inspectImageBuffer(Buffer.alloc(0))).degenerate, 'archivo vacío (0 bytes)');
});

test('instrumented engine/tool never change results and log failures', async () => {
  const env = { SIRAGPT_GENERATION_LOG: '1' };
  const seen = [];
  const origError = console.error;
  console.error = (text) => seen.push(String(text));
  try {
    const failing = generation.instrumentImageEngine('image', async () => ({ ok: false, code: 'E_PROVIDER', error: 'boom', attempts: [{ provider: 'xai', model: 'm', ok: false, error: '500' }] }), { env });
    const res = await failing({ prompt: 'p1' });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'E_PROVIDER');
    const tools = [{ name: 'generate_music', execute: async () => ({ ok: false, error: 'quota' }) }, { name: 'other', execute: async () => 1 }];
    generation.instrumentGenerationTools(tools, { env });
    assert.deepEqual(await tools[0].execute({ prompt: 'jazz' }), { ok: false, error: 'quota' });
    assert.equal(await tools[1].execute({}), 1);
    const throwing = [{ name: 'generate_speech', execute: async () => { throw new Error('tts down'); } }];
    generation.instrumentGenerationTools(throwing, { env });
    await assert.rejects(() => throwing[0].execute({ text: 'hola' }), /tts down/);
  } finally {
    console.error = origError;
  }
  assert.ok(seen.some((s) => s.startsWith('[generation] image falló') && s.includes('"prompt":"p1"')));
  assert.ok(seen.some((s) => s.startsWith('[generation] music falló')));
  assert.ok(seen.some((s) => s.startsWith('[generation] speech falló') && s.includes('tts down')));
});
