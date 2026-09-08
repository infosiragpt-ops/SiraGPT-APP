'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/engine-adapter.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const ad = require('../src/services/agent-runner/engine-adapter');

test('3H34-A-001 pgvector rank sorts by score*recency and fail-closes on missing', () => {
  const now = 1_000_000;
  const out = ad.rankPgvectorHits([
    { text: 'old high', score: 0.99, at: now - 30 * 86400000 },
    { text: 'fresh mid', score: 0.5, at: now },
    { text: 'dup', score: 0.4, at: now },
    { text: 'dup', score: 0.39, at: now },
  ], { now, limit: 8, halfLifeMs: 7 * 86400000 });
  assert.equal(out.ok, true);
  assert.ok(out.hits[0].text === 'fresh mid' || out.hits[0].rank >= out.hits[1].rank);
  assert.ok(out.dropped >= 1);
  const miss = ad.rankPgvectorHits(null);
  assert.equal(miss.ok, false);
  assert.equal(miss.code, 'pgvector_failed');
  assert.deepEqual(miss.hits, []);
});

test('3H34-B-001 rollback last N edits keeps last-1 helper working', () => {
  const ck = {};
  ad.rememberFileEdit(ck, { path: 'a.js', before: 'A0', after: 'A1' });
  ad.rememberFileEdit(ck, { path: 'b.js', before: 'B0', after: 'B1' });
  ad.rememberFileEdit(ck, { path: 'c.js', before: 'C0', after: 'C1' });
  const applied = [];
  const n = ad.rollbackLastNFileEdits(ck, { n: 2, apply: (p, b) => applied.push([p, b]) });
  assert.equal(n.ok, true);
  assert.equal(n.reverted, 2);
  assert.deepEqual(applied, [['c.js', 'C0'], ['b.js', 'B0']]);
  const one = ad.rollbackLastFileEdit(ck, { apply: () => {} });
  assert.equal(one.ok, true);
  assert.equal(one.path, 'a.js');
});

test('3H34-C-001 token audit log records 0-token rows and sweeps TTL', () => {
  ad.resetTokenAuditLog();
  ad.appendTokenAuditLog({ session: 's1', prompt: 10, completion: 5, model: 'flash' }, { now: 1000 });
  ad.appendTokenAuditLog({ session: 's1', prompt: 0, completion: 0, code: 'credit_no_usage' }, { now: 2000 });
  const snap = ad.tokenAuditSnapshot();
  assert.equal(snap.size, 2);
  assert.equal(snap.rows[1].total, 0);
  const swept = ad.sweepTokenAuditLog({ now: 2000 + 31 * 60 * 1000, ttlMs: 30 * 60 * 1000 });
  assert.equal(swept.dropped, 2);
  ad.resetTokenAuditLog();
});

test('3H34-D-001 fair generate lock queues FIFO then rejects at cap', () => {
  ad.resetFairGenerateLock();
  const a = ad.acquireFairGenerateLock('sess', 'p1', { now: 1 });
  assert.equal(a.ok, true);
  const b = ad.acquireFairGenerateLock('sess', 'p2', { now: 2 });
  assert.equal(b.ok, false);
  assert.equal(b.queued, true);
  assert.equal(b.position, 1);
  const c = ad.acquireFairGenerateLock('sess', 'p3', { now: 3 });
  assert.equal(c.position, 2);
  ad.acquireFairGenerateLock('sess', 'p4', { now: 4 });
  ad.acquireFairGenerateLock('sess', 'p5', { now: 5 });
  const overflow = ad.acquireFairGenerateLock('sess', 'p6', { now: 6, maxWaiters: 4 });
  assert.equal(overflow.ok, false);
  assert.equal(overflow.queued, false);
  assert.equal(overflow.code, 'queue_fairness');
  const rel = ad.releaseFairGenerateLock('sess', 'p1', { now: 7 });
  assert.equal(rel.promoted, 'p2');
  ad.resetFairGenerateLock();
});

test('3H34-E-001 GET-like tool cache hits reads and busts on write', () => {
  ad.resetToolCache();
  const miss = ad.lookupGetLikeToolCache('read_file', { path: 'a.js' }, { now: 1 });
  assert.equal(miss.hit, false);
  ad.storeGetLikeToolCache('read_file', { path: 'a.js' }, 'hello', { now: 1 });
  const hit = ad.lookupGetLikeToolCache('read_file', { path: 'a.js' }, { now: 2 });
  assert.equal(hit.hit, true);
  assert.equal(hit.result, 'hello');
  const noWrite = ad.storeGetLikeToolCache('write_file', { path: 'a.js' }, 'nope', { now: 3 });
  assert.equal(noWrite.stored, false);
  const bust = ad.invalidateToolCacheOnWrite('a.js');
  assert.ok(bust.dropped >= 1);
  const after = ad.lookupGetLikeToolCache('read_file', { path: 'a.js' }, { now: 4 });
  assert.equal(after.hit, false);
  ad.resetToolCache();
});

test('3H34-F-001 model timeout is distinct from tool timeout', () => {
  const model = ad.splitModelVsToolTimeout('model');
  const tool = ad.splitModelVsToolTimeout('tool', 'web_fetch');
  const bash = ad.splitModelVsToolTimeout('tool', 'bash');
  assert.equal(model.kind, 'model');
  assert.equal(model.timeoutMs, 45_000);
  assert.equal(model.ttfbMs, 12_000);
  assert.equal(model.code, 'provider_timeout');
  assert.equal(tool.kind, 'tool');
  assert.equal(tool.timeoutMs, 8_000);
  assert.equal(tool.code, 'tool_timeout');
  assert.ok(bash.timeoutMs > tool.timeoutMs);
});

test('3H34-G-001 additionalProperties false strips extras and required fail-closed', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: { path: { type: 'string' }, limit: { type: 'number' } },
  };
  const stripped = ad.stripAdditionalProperties({ path: 'a.js', limit: 10, evil: 1, __proto__: 'x' }, schema);
  assert.equal(stripped.ok, true);
  assert.equal(stripped.stripped >= 1, true);
  assert.equal(stripped.args.path, 'a.js');
  assert.equal(stripped.args.evil, undefined);
  assert.equal(stripped.code, 'schema_strip');
  const miss = ad.stripAdditionalProperties({ limit: 1 }, schema);
  assert.equal(miss.ok, false);
  assert.equal(miss.code, 'schema_invalid');
  const open = ad.stripAdditionalProperties({ a: 1 }, { type: 'object', properties: { a: { type: 'number' } } });
  assert.equal(open.skipped, true);
});

test('3H34-H-001 NFC jail maps fullwidth dots to traversal and keeps relative ok', () => {
  const sneak = ad.workspacePathJail('\uFF0E\uFF0E/etc/passwd', '/tmp/ws');
  assert.equal(sneak.ok, false);
  assert.equal(sneak.code, 'path_traversal');
  const ok = ad.workspacePathJail('src/a.js', '/tmp/ws');
  assert.equal(ok.ok, true);
  const composed = ad.nfcPath('e\u0301');
  assert.equal(composed, 'é');
});

test('3H34-I-001 symlink escape rejected when realpath leaves root', () => {
  const root = '/tmp/ws';
  const inside = path.join(root, 'link');
  const out = ad.rejectSymlinkEscape('link', root, {
    lstatSync: () => ({ isSymbolicLink: () => true }),
    realpathSync: () => '/etc/passwd',
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'symlink_rejected');
  const safe = ad.rejectSymlinkEscape('link', root, {
    lstatSync: () => ({ isSymbolicLink: () => true }),
    realpathSync: () => path.join(root, 'real.txt'),
  });
  assert.equal(safe.ok, true);
  const file = ad.rejectSymlinkEscape('a.js', root, {
    lstatSync: () => ({ isSymbolicLink: () => false }),
    realpathSync: () => path.join(root, 'a.js'),
  });
  assert.equal(file.ok, true);
  assert.equal(file.symlink, false);
});

test('3H34-J-001 SSE comments do not bump seq; events do', () => {
  const c = ad.classifySseFrame(': ping\n\n');
  assert.equal(c.kind, 'comment');
  assert.equal(c.seqBump, false);
  const e = ad.classifySseFrame('id: 3\nevent: token\ndata: {}\n\n');
  assert.equal(e.kind, 'event');
  assert.equal(e.seqBump, true);
  const n1 = ad.nextSseSeqForFrame(4, ': ping\n\n');
  assert.equal(n1.seq, 4);
  const n2 = ad.nextSseSeqForFrame(4, 'data: x\n\n');
  assert.equal(n2.seq, 5);
});

test('3H34-K-001 0-token error refunds hold; tokens>0 still charges', () => {
  let released = 0;
  const hold = { release() { released += 1; } };
  const z = ad.refundZeroTokenError({ usage: { total_tokens: 0 }, error: new Error('provider'), hold });
  assert.equal(z.refunded, true);
  assert.equal(z.charged, false);
  assert.equal(z.code, 'credit_no_usage');
  assert.equal(released, 1);
  const charged = ad.refundZeroTokenError({ usage: { prompt_tokens: 12, completion_tokens: 3 }, error: new Error('x'), hold });
  assert.equal(charged.charged, true);
  assert.equal(charged.refunded, false);
  const ok = ad.refundZeroTokenError({ usage: { total_tokens: 0 }, error: null, hold });
  assert.equal(ok.refunded, false);
});

test('3H34-L-001 compact until remaining budget drops old bodies', () => {
  const huge = 'z'.repeat(4000);
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'tool', name: 'old', content: huge },
    { role: 'tool', name: 'mid', content: huge },
    { role: 'user', content: 'go' },
  ];
  const out = ad.compactUntilTokenBudget(msgs, { remaining: 200, keep: 1 });
  assert.ok(out.used <= 200 || out.compressed === true);
  assert.ok(out.rounds >= 1);
  assert.equal(out.messages[0].role, 'system');
});

test('3H34-M-001 subagent steps never exceed parent and split among siblings', () => {
  const one = ad.inheritSubagentSteps({ parentRemaining: 10, childRequested: 20, siblings: 1 });
  assert.equal(one.budget, 10);
  const two = ad.inheritSubagentSteps({ parentRemaining: 10, childRequested: 20, siblings: 2 });
  assert.equal(two.budget, 5);
  const empty = ad.inheritSubagentSteps({ parentRemaining: 0, childRequested: 5, siblings: 1 });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'subagent_budget');
});

test('3H34-N-001 cross-process file lock wx + stale steal with stub fs', () => {
  const mem = new Map();
  const stub = {
    writeFileSync(p, data, opts) {
      if (opts && opts.flag === 'wx' && mem.has(p)) {
        const e = new Error('EEXIST'); e.code = 'EEXIST'; throw e;
      }
      mem.set(p, String(data));
    },
    readFileSync(p) {
      if (!mem.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return mem.get(p);
    },
    unlinkSync(p) { mem.delete(p); },
  };
  const a = ad.acquireCrossProcessFileLock('/tmp/ws/a.js', { fsApi: stub, now: 1000, ttlMs: 100, lockDir: '/tmp' });
  assert.equal(a.ok, true);
  const busy = ad.acquireCrossProcessFileLock('/tmp/ws/a.js', { fsApi: stub, now: 1010, ttlMs: 100, lockDir: '/tmp' });
  assert.equal(busy.ok, false);
  assert.equal(busy.code, 'path_mutation_busy');
  const stolen = ad.acquireCrossProcessFileLock('/tmp/ws/a.js', { fsApi: stub, now: 1200, ttlMs: 100, lockDir: '/tmp' });
  assert.equal(stolen.ok, true);
  assert.equal(stolen.stolen, true);
  stolen.release();
});

test('3H34-O-001 adapter snapshot flags 3H34 without reverting 3H33', () => {
  const s = ad.adapterSnapshot();
  assert.equal(s.readLineNumbers, true);
  assert.equal(s.compactKeepLastNBodies, true);
  assert.equal(s.workspacePathJail, true);
  assert.equal(s.pgvectorRankHits, true);
  assert.equal(s.rollbackLastNEdits, true);
  assert.equal(s.tokenAuditLog, true);
  assert.equal(s.fairGenerateLock, true);
  assert.equal(s.getLikeToolCache, true);
  assert.equal(s.modelVsToolTimeout, true);
  assert.equal(s.additionalPropertiesStrip, true);
  assert.equal(s.nfcPathJail, true);
  assert.equal(s.symlinkEscapeReject, true);
  assert.equal(s.sseCommentVsEvent, true);
  assert.equal(s.zeroTokenRefund, true);
  assert.equal(s.compactTokenBudget, true);
  assert.equal(s.subagentStepInherit, true);
  assert.equal(s.crossProcessFileLock, true);
  assert.equal(s.openrouterGenerate, false);
  assert.equal(s.interpreter, 'local');
});

test('3H34-P-001 live loop/queue/sse/gateway import 3H34 helpers', () => {
  const loop = read('src/services/agent-runner/loop.js');
  assert.ok(loop.includes('rankPgvectorHits'));
  assert.ok(loop.includes('compactUntilTokenBudget'));
  assert.ok(loop.includes('rejectSymlinkEscape'));
  assert.ok(loop.includes('stripAdditionalProperties'));
  assert.ok(loop.includes('acquireCrossProcessFileLock'));
  assert.ok(loop.includes('refundZeroTokenError'));
  assert.ok(loop.includes('inheritSubagentSteps'));
  const q = read('src/services/agent-gateway/queue.js');
  assert.ok(q.includes('acquireFairGenerateLock'));
  const sse = read('src/utils/sse-writer.js');
  assert.ok(sse.includes('classifySseFrame'));
  const gw = read('src/services/agent-runner/engine-gateway.js');
  assert.ok(gw.includes('stripAdditionalProperties'));
  const ra = read('src/services/react-agent.js');
  assert.ok(ra.includes('stripAdditionalProperties'));
  const acs = read('src/services/agentic-chat-stream.js');
  assert.ok(acs.includes('splitModelVsToolTimeout'));
});

test('3H34-Q-001 no OpenRouter generate path and DeepSeek lock intact', () => {
  const src = read('src/services/agent-runner/engine-adapter.js');
  assert.ok(src.includes('refuseOpenRouterEnv'));
  assert.ok(src.includes('allowDeepSeekGenerateModel'));
  assert.equal(ad.refuseOpenRouterEnv({ SIRAGPT_USE_OPENROUTER: '1' }).ok, false);
  assert.equal(ad.allowDeepSeekGenerateModel('deepseek-v4-flash').ok, true);
  assert.equal(ad.allowDeepSeekGenerateModel('openrouter/gpt-4').ok, false);
});

test('3H34-R-001 error codes include 3H34 taxonomy', () => {
  const { CODES, isRetryable } = require('../src/services/error_codes');
  assert.equal(CODES.SYMLINK_REJECTED, 'symlink_rejected');
  assert.equal(CODES.QUEUE_FAIRNESS, 'queue_fairness');
  assert.equal(CODES.SCHEMA_STRIP, 'schema_strip');
  assert.equal(isRetryable('queue_fairness'), true);
  assert.equal(isRetryable('credit_no_usage'), true);
});

test('3H34-S-001 public stream maps schema_strip and token_compact in ES', () => {
  const src = read('src/services/observability/public-stream-error.js');
  assert.ok(src.includes("code: 'schema_strip'"));
  assert.ok(/Quite propiedades extra/i.test(src));
  assert.ok(src.includes("code: 'token_compact'"));
  assert.ok(src.includes("code: 'symlink_rejected'"));
  assert.ok(/enlace simbolico/i.test(src));
});

test('3H34-T-001 3H33 helpers still exported (no smash)', () => {
  assert.equal(typeof ad.formatReadWithLineNumbers, 'function');
  assert.equal(typeof ad.compactKeepLastNBodies, 'function');
  assert.equal(typeof ad.workspacePathJail, 'function');
  assert.equal(typeof ad.sessionGenerateRateLimit, 'function');
  assert.equal(typeof ad.startBackgroundBash, 'function');
  assert.equal(typeof ad.detectSseGap, 'function');
  assert.equal(typeof ad.rollbackLastFileEdit, 'function');
});

test('3H34-U-001 cache TTL expires GET hits', () => {
  ad.resetToolCache();
  ad.storeGetLikeToolCache('glob', { q: 'src/**' }, ['a.js'], { now: 0 });
  const hit = ad.lookupGetLikeToolCache('glob', { q: 'src/**' }, { now: 100, ttlMs: 8_000 });
  assert.equal(hit.hit, true);
  const exp = ad.lookupGetLikeToolCache('glob', { q: 'src/**' }, { now: 9_000, ttlMs: 8_000 });
  assert.equal(exp.hit, false);
  assert.equal(exp.expired, true);
  ad.resetToolCache();
});

test('3H34-V-001 edit stack caps at 8', () => {
  const ck = {};
  for (let i = 0; i < 12; i += 1) ad.rememberFileEdit(ck, { path: `f${i}.js`, before: 'x', after: 'y' });
  assert.equal(ck.edits.length, 8);
  assert.equal(ck.lastFileEdit.path, 'f11.js');
});
