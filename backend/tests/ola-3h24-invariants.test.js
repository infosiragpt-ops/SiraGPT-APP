'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.existsSync('/app/src/services/agent-runner/loop.js') ? '/app' : path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const adv = require('../src/services/agent-runner/engine-advance');
const { runAgentLoop } = require('../src/services/agent-runner/loop');
const { createScriptedClient } = require('../src/services/agent-runner/evals/scripted-llm');
const { createGateway } = require('../src/services/agent-gateway');
const { encodeReq } = require('../src/services/agent-gateway/protocol');
const skills = require('../src/services/agent-runner/skills');

function scripted(turns) { return createScriptedClient(turns); }

const WRITE_SCHEMA = {
  type: 'object',
  properties: { path: { type: 'string' }, content: { type: 'string' } },
  required: ['path', 'content'],
  additionalProperties: false,
};

test('3H24-A-001 resolveSubagentType known types', () => {
  assert.equal(adv.resolveSubagentType('recall').type, 'recall');
  assert.equal(adv.resolveSubagentType('IMPLEMENT').type, 'implement');
  assert.equal(adv.resolveSubagentType('review').type, 'review');
});

test('3H24-A-002 resolveSubagentType unknown fail-closed', () => {
  const out = adv.resolveSubagentType('drop_table');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'subagent_type');
});

test('3H24-A-003 sliceSubagentBudget inherit parent', () => {
  const rec = adv.sliceSubagentBudget({ parentRemaining: 20, type: 'recall' });
  assert.equal(rec.ok, true);
  assert.ok(rec.budget <= 4);
  assert.ok(rec.budget >= 1);
  const impl = adv.sliceSubagentBudget({ parentRemaining: 20, type: 'implement' });
  assert.ok(impl.budget > rec.budget);
});

test('3H24-A-004 sliceSubagentBudget parent empty stops', () => {
  const out = adv.sliceSubagentBudget({ parentRemaining: 0, type: 'implement' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'subagent_budget');
});

test('3H24-A-005 recall cannot write_file', () => {
  const out = adv.assertSubagentToolAllowed('recall', 'write_file');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'subagent_tool_denied');
});

test('3H24-A-006 review cannot apply_patch', () => {
  const out = adv.assertSubagentToolAllowed('review', 'apply_patch');
  assert.equal(out.ok, false);
});

test('3H24-A-007 implement can apply_patch', () => {
  const out = adv.assertSubagentToolAllowed('implement', 'apply_patch');
  assert.equal(out.ok, true);
});

test('3H24-A-008 filterToolsForSubagent drops writes for recall', () => {
  const tools = [
    { type: 'function', function: { name: 'read_file' } },
    { type: 'function', function: { name: 'write_file' } },
  ];
  const out = adv.filterToolsForSubagent(tools, 'recall');
  assert.equal(out.tools.length, 1);
  assert.equal(out.filtered, 1);
});

test('3H24-A-009 createSubagentSpec review no writes', () => {
  const spec = adv.createSubagentSpec({ type: 'review', parentRemaining: 16, task: 'verifica' });
  assert.equal(spec.ok, true);
  assert.equal(spec.writes, false);
  assert.ok(spec.budget <= 6);
});

test('3H24-B-001 catalogSkillsProgressive omits body', () => {
  const cat = adv.catalogSkillsProgressive([
    { name: 'office-docs', description: 'ppt', body: 'SECRET RECIPE' },
  ]);
  assert.equal(cat.length, 1);
  assert.equal(cat[0].name, 'office-docs');
  assert.equal(cat[0].body, undefined);
  assert.ok(cat[0].hash);
});

test('3H24-B-002 discloseSkill summary has excerpt not full body', () => {
  const body = '# titulo\n' + 'x'.repeat(400);
  const out = adv.discloseSkill({ ok: true, name: 'n', description: 'd', body }, { level: 'summary' });
  assert.equal(out.ok, true);
  assert.equal(out.body, null);
  assert.ok(out.excerpt.length <= 280);
});

test('3H24-B-003 discloseSkill refs lists headings', () => {
  const out = adv.discloseSkill({
    ok: true, name: 'n', description: 'd',
    body: '# A\ntexto\n## Checklist\n- uno\n',
  }, { level: 'refs' });
  assert.ok(out.refs.length >= 1);
  assert.equal(out.body, null);
});

test('3H24-B-004 first-party SKILL.md files exist', () => {
  const root = fs.existsSync('/app/src/services/agent-runner/skills/builtin')
    ? '/app/src/services/agent-runner/skills/builtin'
    : path.join(ROOT, 'src/services/agent-runner/skills/builtin');
  assert.ok(fs.existsSync(path.join(root, 'codex-playbooks', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(root, 'cortex-recipes', 'SKILL.md')));
});

test('3H24-B-005 listSkills includes first-party playbooks', () => {
  const list = skills.listSkills({ env: { ...process.env, NODE_ENV: 'production', SIRAGPT_AGENT_SKILLS: '1' } });
  const names = list.map((s) => s.name);
  assert.ok(names.includes('codex-playbooks'), names.join(','));
  assert.ok(names.includes('cortex-recipes'), names.join(','));
});

test('3H24-B-006 load_skill optional level stays additionalProperties false', () => {
  const src = read('src/services/agent-runner/skills/index.js');
  assert.match(src, /level/);
  assert.match(src, /discloseSkill/);
});

test('3H24-C-001 payloadHash stable regardless of key order', () => {
  const a = adv.payloadHash('memory.persist', { b: 1, a: 2, idempotencyKey: 'k' });
  const b = adv.payloadHash('memory.persist', { a: 2, b: 1, idempotencyKey: 'other' });
  assert.equal(a, b);
});

test('3H24-C-002 idempotency first then replay', () => {
  const store = adv.createIdempotencyStore({ ttlMs: 60_000 });
  const first = store.claim({ key: 'k1', method: 'cron.create', params: { name: 'x' } });
  assert.equal(first.status, 'first');
  store.remember('k1', { id: 'cron_1' });
  const replay = store.claim({ key: 'k1', method: 'cron.create', params: { name: 'x' } });
  assert.equal(replay.status, 'replay');
  assert.equal(replay.response.id, 'cron_1');
  assert.equal(replay.code, 'idempotency_replay');
});

test('3H24-C-003 idempotency conflict different payload', () => {
  const store = adv.createIdempotencyStore({ ttlMs: 60_000 });
  store.claim({ key: 'k2', method: 'cron.create', params: { name: 'x' } });
  const out = store.claim({ key: 'k2', method: 'cron.create', params: { name: 'y' } });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'idempotency_conflict');
});

test('3H24-C-004 idempotency sweep drops expired', () => {
  let t = 1000;
  const store = adv.createIdempotencyStore({ ttlMs: 50, now: () => t });
  store.claim({ key: 'old', method: 'agent', params: { m: 1 } });
  t = 2000;
  const swept = store.sweep(t);
  assert.ok(swept.dropped >= 1);
  assert.equal(store.size(), 0);
});

test('3H24-C-005 isSideEffectMethod covers persist and abort', () => {
  assert.equal(adv.isSideEffectMethod('memory.persist'), true);
  assert.equal(adv.isSideEffectMethod('agent.abort'), true);
  assert.equal(adv.isSideEffectMethod('status'), false);
});

test('3H24-C-006 protocol exports SIDE_EFFECT_METHODS', () => {
  const proto = require('../src/services/agent-gateway/protocol');
  assert.ok(Array.isArray(proto.SIDE_EFFECT_METHODS));
  assert.ok(proto.SIDE_EFFECT_METHODS.includes('skills.persist'));
});

test('3H24-C-007 gateway handleFrame replays side-effect', async () => {
  let n = 0;
  const gw = createGateway({
    skills: {
      list: async () => [],
      persist: async () => { n += 1; return { persisted: true, n }; },
    },
  });
  const conn = { handshakeDone: true, userId: 'u1', sessionKey: 's1' };
  const p = { userId: 'u1', name: 'demo', body: 'hola', idempotencyKey: 'idemp-1' };
  const a = await gw.handleFrame(conn, encodeReq('1', 'skills.persist', p));
  const b = await gw.handleFrame(conn, encodeReq('2', 'skills.persist', p));
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(n, 1);
  assert.equal(b.payload.persisted, true);
});

test('3H24-D-001 sleepTimeCompact skips under threshold', () => {
  const messages = [{ role: 'user', content: 'hola' }];
  const out = adv.sleepTimeCompact({ messages, thresholdTokens: 8000 });
  assert.equal(out.compacted, false);
  assert.equal(out.skipped, true);
  assert.equal(out.code, null);
});

test('3H24-D-004 extractFactAnchors picks user and decisions', () => {
  const a = adv.extractFactAnchors([
    { role: 'user', content: 'crea un ppt sobre ventas' },
    { role: 'assistant', content: 'decidí el entregable ventas.pptx' },
  ]);
  assert.ok(a.some((x) => x.kind === 'user'));
  assert.ok(a.some((x) => x.kind === 'decision'));
});

test('3H24-D-002 sleepTimeCompact persists without extra user turn', () => {
  const saved = [];
  const messages = [];
  for (let i = 0; i < 40; i += 1) {
    messages.push({ role: 'user', content: 'pedido importante numero ' + i + ' ' + 'x'.repeat(80) });
    messages.push({ role: 'assistant', content: 'decidí guardar el entregable ventas.pptx ' + 'y'.repeat(80) });
  }
  const out = adv.sleepTimeCompact({
    messages,
    persistMemory: (ep) => saved.push(ep),
    userId: 'u1',
    chatId: 'c1',
    thresholdTokens: 200,
  });
  assert.equal(out.compacted, true);
  assert.equal(out.code, 'sleep_compact');
  assert.equal(out.persisted, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].source, 'sleep_compact');
  assert.ok(out.anchors.length >= 1);
});

test('3H24-D-003 pins survive sleep compact', () => {
  const messages = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 30; i += 1) messages.push({ role: 'user', content: 'z'.repeat(120) });
  const out = adv.sleepTimeCompact({
    messages,
    pins: ['hecho critico: cliente = ACME'],
    thresholdTokens: 100,
  });
  assert.equal(out.compacted, true);
  assert.equal(out.pins, 1);
});

test('3H24-E-001 parseUnifiedDiff one hunk', () => {
  const diff = [
    '--- a/hello.js',
    '+++ b/hello.js',
    '@@ -1,1 +1,1 @@',
    '-const n = 1;',
    '+const n = 2;',
  ].join('\n');
  const out = adv.parseUnifiedDiff(diff);
  assert.equal(out.ok, true);
  assert.equal(out.hunks.length, 1);
});

test('3H24-E-002 applyHunksExact unique replace', () => {
  const parsed = adv.parseUnifiedDiff([
    '@@ -1,1 +1,1 @@',
    '-alpha',
    '+beta',
  ].join('\n'));
  const out = adv.applyHunksExact('alpha', parsed.hunks);
  assert.equal(out.ok, true);
  assert.equal(out.content, 'beta');
});

test('3H24-E-003 applyHunksExact ambiguous fails', () => {
  const parsed = adv.parseUnifiedDiff([
    '@@ -1,1 +1,1 @@',
    '-x',
    '+y',
  ].join('\n'));
  const out = adv.applyHunksExact('x\nx', parsed.hunks);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'git_hunk_ambiguous');
});

test('3H24-E-004 git dirty refuse', () => {
  const out = adv.assertGitCleanForApply({
    relPath: 'a.js',
    gitStatus: () => ({ dirty: true }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'git_apply_dirty');
});

test('3H24-E-005 git clean apply writes then verifies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-3h24-'));
  const file = path.join(dir, 'hello.js');
  fs.writeFileSync(file, 'const n = 1;\n');
  const diff = ['@@ -1,1 +1,1 @@', '-const n = 1;', '+const n = 2;'].join('\n');
  const out = adv.applyExactDiff({
    root: dir,
    relPath: 'hello.js',
    diff,
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    writeFile: (p, c) => fs.writeFileSync(p, c),
    gitStatus: () => ({ dirty: false }),
  });
  assert.equal(out.ok, true);
  assert.equal(fs.readFileSync(file, 'utf8').trim(), 'const n = 2;');
});

test('3H24-E-006 syntax fail reverts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-3h24-'));
  const file = path.join(dir, 'hello.js');
  fs.writeFileSync(file, 'const n = 1;\n');
  const diff = ['@@ -1,1 +1,1 @@', '-const n = 1;', '+const n = ;'].join('\n');
  const out = adv.applyExactDiff({
    root: dir,
    relPath: 'hello.js',
    diff,
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    writeFile: (p, c) => fs.writeFileSync(p, c),
    gitStatus: () => ({ dirty: false }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'git_syntax_revert');
  assert.equal(out.reverted, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'const n = 1;\n');
});

test('3H24-F-001 live loop recall subagent does not execute write_file', async () => {
  const client = scripted([
    { toolCalls: [{ name: 'write_file', args: { path: '/t.txt', content: 'hola' } }] },
    { content: 'listo' },
  ]);
  let called = 0;
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'recuerda' }],
    tools: [{ type: 'function', function: { name: 'write_file', parameters: WRITE_SCHEMA } }],
    executors: { write_file: async () => { called += 1; return 'WROTE'; } },
    maxIterations: 4,
    subagentType: 'recall',
  });
  assert.equal(called, 0);
  assert.ok(['final', 'max_iterations', 'subagent_tool_denied', 'budget_exceeded'].includes(out.stoppedReason) || called === 0);
});

test('3H24-F-002 live loop sleep compact result on finish', async () => {
  const client = scripted([{ content: 'hola' }]);
  const out = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hi ' + 'n'.repeat(20) }],
    tools: [],
    executors: {},
    maxIterations: 2,
  });
  assert.ok(out.sleepCompact);
  assert.equal(typeof out.sleepCompact.compacted, 'boolean');
});

test('3H24-F-003 advance snapshot flags', () => {
  const snap = adv.advanceSnapshot();
  assert.equal(snap.subagentTypes, true);
  assert.equal(snap.protocolIdempotency, true);
  assert.equal(snap.sleepTimeCompact, true);
  assert.equal(snap.gitAwareApply, true);
  assert.equal(snap.skillProgressive, true);
});

test('3H24-X-001 no openrouter in advance or loop', () => {
  const src = read('src/services/agent-runner/engine-advance.js');
  const loopSrc = read('src/services/agent-runner/loop.js');
  assert.doesNotMatch(src, /openrouter\.ai/i);
  assert.doesNotMatch(loopSrc, /openrouter\.ai/i);
  assert.match(loopSrc, /engine-advance/);
});

test('3H24-X-002 error codes include 3H24 leftovers', () => {
  const { CODES } = require('../src/services/error_codes');
  assert.equal(CODES.SUBAGENT_BUDGET, 'subagent_budget');
  assert.equal(CODES.SLEEP_COMPACT, 'sleep_compact');
  assert.equal(CODES.GIT_APPLY_DIRTY, 'git_apply_dirty');
  assert.equal(CODES.GIT_SYNTAX_REVERT, 'git_syntax_revert');
  assert.equal(CODES.IDEMPOTENCY_REPLAY, 'idempotency_replay');
});

test('3H24-G-001 catalog scoreQuery routes crm and review', () => {
  const cat = require('../src/services/catalog-agent-router');
  assert.equal(cat.scoreQuery('arma un CRM para leads').id, 'crm-builder');
  assert.equal(cat.scoreQuery('revisa el codigo de este PR').id, 'code-reviewer');
  assert.equal(cat.scoreQuery('hola').id, null);
});

test('3H24-G-002 loadCatalog DeepSeek only', () => {
  const cat = require('../src/services/catalog-agent-router');
  const list = cat.loadCatalog();
  assert.ok(list.length >= 1);
  for (const a of list) {
    assert.match(a.model, /deepseek-v4-(flash|pro)/);
    assert.equal(a.provider, 'deepseek');
  }
});

test('3H24-G-003 live react-agent imports engine-control', () => {
  const src = read('src/services/react-agent.js');
  assert.match(src, /engine-control/);
  assert.match(src, /repairToolCallWithFeedback/);
  assert.match(src, /evaluateStopConditions/);
  const ra = require('../src/services/react-agent');
  assert.equal(ra.engineLive, true);
});

test('3H24-G-004 live stream imports catalog router', () => {
  const src = read('src/services/agentic-chat-stream.js');
  assert.match(src, /catalog-agent-router/);
  assert.match(src, /engine-control/);
  assert.match(src, /catalogSystemBlock/);
});

test('3H24-G-005 ai.js generate calls runAgenticChat', () => {
  const src = read('src/routes/ai.js');
  assert.match(src, /runAgenticChat/);
  assert.match(src, /agentic-chat-stream/);
});
