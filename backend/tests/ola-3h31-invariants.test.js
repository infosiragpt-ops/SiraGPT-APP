'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-lifecycle.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const life = require('../src/services/agent-runner/engine-lifecycle');

test('3H31-A-001 monotonic seq rejects non-increasing', () => {
  const gate = life.createEventOrderGate();
  const a = gate.next({ type: 'a' }, 1);
  const b = gate.next({ type: 'b' }, 1);
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(b.code, 'event_order');
  const c = gate.next({ type: 'c' }, 2);
  assert.equal(c.ok, true);
  assert.equal(c.seq, 2);
});

test('3H31-A-002 duplicate tool result same id+hash is dropped', () => {
  const store = new Map();
  const first = life.recordToolResultOnce(store, { toolCallId: 'c1', result: 'ok' });
  const dup = life.recordToolResultOnce(store, { toolCallId: 'c1', result: 'ok' });
  const other = life.recordToolResultOnce(store, { toolCallId: 'c1', result: 'ok2' });
  assert.equal(first.emit, true);
  assert.equal(dup.emit, false);
  assert.equal(dup.code, 'tool_result_dup');
  assert.equal(other.emit, true);
});

test('3H31-A-003 single gateway claim rejects second producer', () => {
  life.resetGatewayClaims();
  const a = life.claimSingleGateway('s1', 'p1');
  const b = life.claimSingleGateway('s1', 'p2');
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(b.code, 'gateway_busy');
  a.release();
  const c = life.claimSingleGateway('s1', 'p2');
  assert.equal(c.ok, true);
  c.release();
});

test('3H31-A-004 drainOrNackOnClose nacks when emit missing', () => {
  const out = life.drainOrNackOnClose([{ seq: 1 }, { seq: 2 }]);
  assert.equal(out.nacked.length, 2);
  assert.equal(out.code, 'event_order');
});

test('3H31-B-001 unknown tool auto-maps nearest allowed within distance 2', () => {
  const out = life.rewriteUnknownToNearest('exceute_bash', {
    executors: { execute_bash() {}, read_file() {} },
  });
  assert.equal(out.ok, true);
  assert.equal(out.mapped, 'execute_bash');
  assert.equal(out.rewritten, true);
  assert.ok(out.distance <= 2);
});

test('3H31-B-002 far unknown stays tool_unknown with suggestion', () => {
  const out = life.rewriteUnknownToNearest('launch_nukes', {
    catalog: ['execute_bash', 'read_file'],
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'tool_unknown');
  assert.ok(out.suggestion);
});

test('3H31-B-003 extra keys stripped against schema', () => {
  const out = life.stripUnknownKeys(
    { path: '/a.js', extra: 1, also: true },
    { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
  );
  assert.deepEqual(out.value, { path: '/a.js' });
  assert.ok(out.stripped.includes('extra'));
});

test('3H31-B-004 enum coerce fuzzy + type coerce + required default + maxItems', () => {
  const schema = {
    type: 'object',
    required: ['lang', 'n'],
    properties: {
      lang: { type: 'string', enum: ['javascript', 'python'] },
      n: { type: 'integer', default: 1 },
      flags: { type: 'array', maxItems: 2 },
      dry: { type: 'boolean' },
    },
  };
  const out = life.repairToolCallSchema(
    { name: 'run', arguments: { lang: 'javascrpt', flags: [1, 2, 3], dry: 'true' } },
    schema,
    { catalog: ['run'] },
  );
  assert.equal(out.ok, true);
  assert.equal(out.args.lang, 'javascript');
  assert.equal(out.args.n, 1);
  assert.equal(out.args.dry, true);
  assert.deepEqual(out.args.flags, [1, 2]);
  assert.ok(out.filled.includes('n'));
});

test('3H31-C-001 file-backed pin roundtrip + size cap', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-pins-'));
  const big = 'x'.repeat(life.PIN_MAX_BYTES + 50);
  const up = life.upsertFilePin('ns1', { id: 'p1', text: big, critical: true }, { root });
  assert.equal(up.ok, true);
  assert.equal(up.truncated, true);
  const loaded = life.loadFilePins('ns1', { root });
  assert.equal(loaded.pins.length, 1);
  assert.match(loaded.pins[0].text, /pin_capped sha256=/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('3H31-C-002 pinAcrossCompact keeps critical facts', () => {
  const msgs = [
    { role: 'system', content: 'base' },
    { role: 'user', content: 'hola' },
    { role: 'assistant', content: 'x'.repeat(200) },
  ];
  const out = life.pinAcrossCompact(msgs, [{ text: 'empresa=Acme', critical: true }]);
  assert.equal(out.pinned, 1);
  assert.match(out.messages[0].content, /PINNED FACTS/);
  assert.match(out.messages[0].content, /Acme/);
});

test('3H31-C-003 searchableMemoryHook file pins without new DB', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-pins-'));
  life.upsertFilePin('mem', { text: 'el cliente prefiere DeepSeek Flash', critical: true }, { root });
  const hit = life.searchableMemoryHook({ query: 'DeepSeek Flash', namespace: 'mem', root });
  assert.equal(hit.ok, true);
  assert.equal(hit.via, 'file_pins');
  assert.ok(hit.hits.length >= 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('3H31-C-004 searchableMemoryHook uses retrieve when provided (pgvector hook)', async () => {
  const out = await life.searchableMemoryHook({
    query: 'q',
    retrieve: async () => [{ text: 'from-store', score: 0.9 }],
  });
  assert.equal(out.via, 'pgvector_or_store');
  assert.equal(out.hits[0].text, 'from-store');
});

test('3H31-C-005 refreshPinTtlOnHit extends expiresAt', () => {
  const now = 1_000_000;
  const out = life.refreshPinTtlOnHit({ id: 'a', expiresAt: 1 }, { now, ttlMs: 5000 });
  assert.equal(out.refreshed, true);
  assert.equal(out.pin.expiresAt, now + 5000);
});

test('3H31-D-001 cancel mid-stream aborts tools, releases hold once, terminal SSE once', () => {
  const registry = life.createInFlightRegistry();
  let aborted = false;
  registry.track({ id: 't1', abort: () => { aborted = true; } });
  const holdState = {};
  const sseState = {};
  const frames = [];
  let releases = 0;
  const hold = { release() { releases += 1; return { ok: true }; } };
  const first = life.cancelMidStream({ registry, hold, holdState, sseState, write: (f) => frames.push(f), reason: 'user' });
  const second = life.cancelMidStream({ registry, hold, holdState, sseState, write: (f) => frames.push(f), reason: 'user' });
  assert.equal(aborted, true);
  assert.equal(first.creditReleased, true);
  assert.equal(first.terminal, true);
  assert.equal(second.creditReleased, false);
  assert.equal(second.terminal, false);
  assert.equal(releases, 1);
  assert.equal(frames.length, 1);
});

test('3H31-E-001 str_replace syntax fail auto-reverts', () => {
  let reverted = null;
  const before = 'const x = 1;';
  const after = 'const x = (1;';
  const out = life.verifyStrReplace({
    pathName: 'a.js',
    before,
    after,
    oldString: '1',
    newString: '(1',
    revert: (b) => { reverted = b; },
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'write_syntax_revert');
  assert.equal(out.reverted, true);
  assert.equal(reverted, before);
});

test('3H31-E-002 json parse fail reverts; valid json passes', () => {
  const bad = life.syntaxCheckAfterEdit('a.json', '{');
  assert.equal(bad.ok, false);
  const good = life.syntaxCheckAfterEdit('a.json', '{"ok":true}');
  assert.equal(good.ok, true);
  const bal = life.bracketBalance('function f() { return 1; }');
  assert.equal(bal.ok, true);
});

test('3H31-E-003 unique hunk leftover old_string fails', () => {
  const out = life.uniqueHunkAfterReplace({
    before: 'foo bar foo',
    after: 'foo baz foo',
    oldString: 'bar',
    newString: 'baz',
  });
  // old still in after as the other foo? oldString is bar, after is foo baz foo — bar gone, ok
  assert.equal(out.ok, true);
  const leftover = life.uniqueHunkAfterReplace({
    before: 'aaa',
    after: 'aaa',
    oldString: 'aaa',
    newString: 'bbb',
  });
  assert.equal(leftover.ok, false);
});

test('3H31-F-001 wall-clock kill independent of CPU', () => {
  const out = life.wallClockExceeded({ startedAt: 1000, now: 1000 + 30_000, wallMs: 30_000 });
  assert.equal(out.kill, true);
  assert.equal(out.reason, 'wall_clock');
  assert.equal(out.code, 'sandbox_timeout');
});

test('3H31-F-002 RSS over limit kills', () => {
  const out = life.rssKillIfOver({ rssBytes: 600 * 1024 * 1024, limitBytes: 512 * 1024 * 1024 });
  assert.equal(out.kill, true);
  assert.equal(out.code, 'sandbox_resource_limit');
});

test('3H31-F-003 termThenKill SIGTERM then SIGKILL after grace', () => {
  const signals = [];
  const kill = (id, sig) => { signals.push(sig); return true; };
  const first = life.termThenKill(42, { kill });
  assert.equal(first.signal, 'SIGTERM');
  const wait = life.termThenKill(42, { kill, termAt: 1000, now: 1100, graceMs: 400 });
  assert.equal(wait.waiting, true);
  const hard = life.termThenKill(42, { kill, termAt: 1000, now: 1500, graceMs: 400 });
  assert.equal(hard.signal, 'SIGKILL');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('3H31-F-004 guaranteed tmp cleanup even after register', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-aw-'));
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
  life.registerTmpForCrashCleanup(dir);
  const out = life.guaranteedTmpCleanup();
  assert.ok(out.cleaned.includes(dir));
  assert.equal(fs.existsSync(dir), false);
});

test('3H31-G-001 first-token watchdog emits heartbeat then escalate', async () => {
  const frames = [];
  const timers = [];
  const wd = life.startFirstTokenWatchdog({
    timeoutMs: 20,
    onHeartbeat: (f) => frames.push(f),
    onEscalate: (f) => frames.push(f),
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    clearTimeoutFn: () => {},
  });
  timers[0].fn();
  timers[1].fn();
  assert.equal(frames[0].code, 'first_token_watchdog');
  assert.equal(frames[0].reason, 'waiting_provider');
  assert.equal(frames[1].code, 'first_token_stall');
  wd.stop();
});

test('3H31-G-002 mark first token cancels watchdog', () => {
  let fired = false;
  const wd = life.startFirstTokenWatchdog({
    timeoutMs: 50,
    onHeartbeat: () => { fired = true; },
    setTimeoutFn: (fn) => ({ unref() {}, fn }),
    clearTimeoutFn: () => {},
  });
  const marked = wd.mark(10);
  wd.snapshot();
  assert.equal(typeof marked.firstTokenMs, 'number');
  assert.equal(fired, false);
  wd.stop();
});

test('3H31-G-003 stall reason distinguishes sandbox vs provider', () => {
  assert.equal(life.classifyStallReason({ inSandbox: true }).reason, 'waiting_sandbox');
  assert.equal(life.classifyStallReason({ inTool: true }).reason, 'waiting_tool');
  assert.equal(life.classifyStallReason({}).reason, 'waiting_provider');
  assert.equal(life.classifyStallReason({ hasToken: true }).reason, null);
});

test('3H31-H-001 provider 429/401/5xx/timeout map without leaking keys', () => {
  const r = life.mapProviderHttp({ status: 429, message: 'rate limit sk-LIVESECRET999' });
  assert.equal(r.code, 'rate_limited');
  assert.equal(r.retryable, true);
  const a = life.mapProviderHttp({ status: 401, message: 'invalid api key sk-ABCDEFGHIJKL' });
  assert.equal(a.code, 'provider_auth');
  assert.doesNotMatch(a.message, /sk-/);
  const s = life.mapProviderHttp({ status: 503, message: 'bad' });
  assert.equal(s.code, 'provider_unavailable');
  const t = life.mapProviderHttp({ code: 'ETIMEDOUT', message: 'timeout' });
  assert.equal(t.code, 'provider_timeout');
  const scrubbed = life.scrubSecretsFromError('Authorization: Bearer abcdefghijklmnop');
  assert.match(scrubbed, /\[redacted\]/);
  assert.doesNotMatch(scrubbed, /abcdefghijklmnop/);
});

test('3H31-H-002 classifyLifecycleError Spanish public codes', () => {
  const c = life.classifyLifecycleError('rate_limited');
  assert.equal(c.retryable, true);
  assert.match(c.message, /saturado/);
  const auth = life.classifyLifecycleError('provider_auth');
  assert.match(auth.message, /clave/);
});

test('3H31-K-001 lifecycleSnapshot flags', () => {
  const s = life.lifecycleSnapshot();
  assert.equal(s.eventOrderMonotonic, true);
  assert.equal(s.rewriteUnknownNearest, true);
  assert.equal(s.fileBackedPins, true);
  assert.equal(s.abortInFlightTools, true);
  assert.equal(s.strReplaceSyntaxRevert, true);
  assert.equal(s.sandboxWallClock, true);
  assert.equal(s.firstTokenWatchdog, true);
  assert.equal(s.providerTaxonomy, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.sandboxUsesRunsc, false);
  assert.equal(s.interpreter, 'local');
});

test('3H31-L-001 live loop.js wires lifecycle', () => {
  const src = read('src/services/agent-runner/loop.js');
  assert.match(src, /engine-lifecycle/);
  assert.match(src, /rewriteUnknownToNearest|repairToolCallSchema/);
  assert.match(src, /startFirstTokenWatchdog|cancelMidStream|verifyStrReplace/);
});

test('3H31-L-002 live chat index + react-agent + agentic stream wire lifecycle', () => {
  const idx = read('src/services/agent-runner/index.js');
  assert.match(idx, /engine-lifecycle/);
  const react = read('src/services/react-agent.js');
  assert.match(react, /engine-lifecycle/);
  assert.match(react, /rewriteUnknownToNearest|repairToolCallSchema|mapProviderHttp/);
  const stream = read('src/services/agentic-chat-stream.js');
  assert.match(stream, /engine-lifecycle/);
  assert.match(stream, /emitTerminalSseOnce|startFirstTokenWatchdog/);
});

test('3H31-L-003 live code agent-loop wires lifecycle', () => {
  const loop = read('src/services/codex/agent-loop.js');
  assert.match(loop, /engine-lifecycle/);
  assert.match(loop, /rewriteUnknownToNearest|verifyStrReplace|mapProviderHttp|cancelMidStream/);
});

test('3H31-L-004 live sandbox sse queue codes health', () => {
  const sandbox = read('src/services/sandbox/local-sandbox.js');
  assert.match(sandbox, /engine-lifecycle/);
  assert.match(sandbox, /sandboxWatchdogTick|guaranteedTmpCleanup|termThenKill/);
  const sse = read('src/utils/sse-writer.js');
  assert.match(sse, /engine-lifecycle/);
  assert.match(sse, /assertMonotonicSeq|emitTerminalSseOnce/);
  const q = read('src/services/agent-gateway/queue.js');
  assert.match(q, /claimSingleGateway|engine-lifecycle/);
  const codes = read('src/services/error_codes.js');
  assert.match(codes, /TOOL_RESULT_DUP: 'tool_result_dup'/);
  assert.match(codes, /GATEWAY_BUSY: 'gateway_busy'/);
  assert.match(codes, /TURN_CANCELLED: 'turn_cancelled'/);
  assert.match(codes, /RATE_LIMITED: 'rate_limited'/);
  assert.match(codes, /PROVIDER_AUTH: 'provider_auth'/);
  assert.match(codes, /FIRST_TOKEN_STALL: 'first_token_stall'/);
  const pub = read('src/services/observability/public-stream-error.js');
  assert.match(pub, /tool_result_dup/);
  assert.match(pub, /rate_limited/);
  assert.match(pub, /provider_auth/);
  assert.match(pub, /first_token_stall/);
  const health = read('src/services/observability/health-check.js');
  assert.match(health, /engine-lifecycle/);
  assert.match(health, /lifecycleSnapshot/);
  const rel = read('src/services/agent-runner/engine-reliability.js');
  assert.match(rel, /classifyLifecycleError|engine-lifecycle/);
});

test('3H31-L-005 DeepSeek lock and no invented secrets', () => {
  const src = read('src/services/agent-runner/engine-lifecycle.js');
  assert.match(src, /openrouterGenerate: false/);
  assert.doesNotMatch(src, /SIRAGPT_WEBHOOK_HMAC_SECRET\s*=/);
  assert.doesNotMatch(src, /usesRunsc:\s*true/);
  assert.doesNotMatch(src, /SIRAGPT_SANDBOX_NET_ALLOW\s*=\s*['"][^'"]+['"]/);
  assert.doesNotMatch(src, /chat_run_worker['"]?\s*:\s*true/);
  assert.match(src, /interpreter: 'local'/);
});

test('3H31-L-006 assertMonotonicSeq helper', () => {
  assert.equal(life.assertMonotonicSeq(3, 4).ok, true);
  assert.equal(life.assertMonotonicSeq(3, 3).ok, false);
  assert.equal(life.assertMonotonicSeq(3, 2).code, 'event_order');
});

test('3H31-L-007 sandboxWatchdogTick rss then wall', () => {
  const signals = [];
  const rss = life.sandboxWatchdogTick({
    startedAt: 1, now: 10, wallMs: 1000,
    rssBytes: 999e9, rssLimit: 1, pid: 9,
    kill: (_id, sig) => { signals.push(sig); return true; },
  });
  assert.equal(rss.kill, true);
  assert.equal(rss.reason, 'rss');
  const wall = life.sandboxWatchdogTick({
    startedAt: 1, now: 5000, wallMs: 10,
    rssBytes: 1, rssLimit: 999e9, pid: 9,
    kill: (_id, sig) => { signals.push(sig); return true; },
  });
  assert.equal(wall.kill, true);
  assert.equal(wall.reason, 'wall_clock');
});
