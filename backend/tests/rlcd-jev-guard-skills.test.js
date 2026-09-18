'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const guard = require('../src/services/rlcd/jev-tool-guard');
const picker = require('../src/services/rlcd/jev-skill-picker');
const ledger = require('../src/services/rlcd/decision-ledger');

function fakeFetch(body, status = 200) {
  const fn = async (url, init) => {
    fn.calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    return { ok: status < 300, status, statusText: '', headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  fn.calls = [];
  return fn;
}
const ENV = { TYPESAFE_API_KEY: 'k' };

test.beforeEach(() => ledger.reset());

test('guard: read-only and media tools are never assessed; writes/actions are', () => {
  for (const t of ['web_search', 'read_file', 'search_docs', 'project_read', 'generate_image', 'create_chart', 'run_skill', 'decide_with_jev', 'finalize', 'list_dir']) assert.equal(guard.shouldAssess(t), false, t);
  for (const t of ['project_write', 'project_exec', 'project_open_pull_request', 'gmail_send', 'computer_write_file', 'delete_memory', 'github_publish_project', 'mcp__srv__delete_row']) assert.equal(guard.shouldAssess(t), true, t);
  assert.equal(guard.isGuardEnabled({}), false);
  assert.equal(guard.isGuardEnabled(ENV), true);
  assert.equal(guard.isGuardEnabled({ ...ENV, SIRAGPT_RLCD_JEV_TOOL_GUARD: '0' }), false);
});

test('guard: irreversible call → confirm with reason + tool_risk decision; harmless call → auto; outcome scoring', async () => {
  const risky = fakeFetch({ model: 'jev-1.13.0', answers: {
    risk: { type: 'choice', choice: 'external_side_effect', probabilities: { read_only: 0.02, reversible_write: 0.08, irreversible: 0.2, external_side_effect: 0.7 }, confidence: 0.7 },
    irreversible: { type: 'noul', noul: 0.9 },
    matches_request: { type: 'noul', noul: 0.4 },
  }, usage: { input_tokens: 100, output_tokens: 0 } });
  const a = await guard.assessToolCall({ toolName: 'gmail_send', args: { to: 'x@y.com', body: 'hola' }, userMessage: 'redacta un correo', chatId: 'c1', env: ENV, fetchImpl: risky, ledger });
  assert.equal(a.confirm, true);
  assert.equal(a.risk, 'external_side_effect');
  assert.match(a.reasonLabel, /efecto externo/);
  assert.ok(a.decisionId);
  assert.equal(ledger.getDecision(a.decisionId).kind, 'tool_risk');
  assert.equal(risky.calls[0].body.state.herramienta, 'gmail_send');
  assert.equal(guard.recordGuardOutcome(a, 'deny', ledger), 1);
  assert.equal(ledger.getDecision(a.decisionId).outcome.label, 'guard_needed');

  const safe = fakeFetch({ model: 'jev-1.13.0', answers: {
    risk: { type: 'choice', choice: 'reversible_write', probabilities: { read_only: 0.1, reversible_write: 0.85, irreversible: 0.03, external_side_effect: 0.02 }, confidence: 0.8 },
    irreversible: { type: 'noul', noul: 0.05 },
    matches_request: { type: 'noul', noul: 0.95 },
  }, usage: { input_tokens: 100, output_tokens: 0 } });
  const b = await guard.assessToolCall({ toolName: 'project_write', args: { path: 'a.txt' }, userMessage: 'crea a.txt', chatId: 'c1', env: ENV, fetchImpl: safe, ledger });
  assert.equal(b.confirm, false);
  assert.equal(ledger.getDecision(b.decisionId).choice, 'auto:reversible_write');
  assert.equal(guard.recordGuardOutcome(b, 'allow', ledger), 1);
  assert.equal(ledger.getDecision(b.decisionId).outcome.label, 'guard_unneeded');

  // unrequested moderate-risk action also asks
  const unrequested = fakeFetch({ model: 'jev-1.13.0', answers: {
    risk: { type: 'choice', choice: 'reversible_write', probabilities: { read_only: 0.1, reversible_write: 0.5, irreversible: 0.3, external_side_effect: 0.1 }, confidence: 0.4 },
    irreversible: { type: 'noul', noul: 0.4 },
    matches_request: { type: 'noul', noul: 0.1 },
  }, usage: { input_tokens: 100, output_tokens: 0 } });
  const c = await guard.assessToolCall({ toolName: 'project_exec', args: { cmd: 'rm -rf build' }, userMessage: 'arregla el test', env: ENV, fetchImpl: unrequested, ledger });
  assert.equal(c.confirm, true);
  assert.match(c.reasonLabel, /no pedida/);

  assert.equal(await guard.assessToolCall({ toolName: 'read_file', args: {}, env: ENV, fetchImpl: risky }), null);
  assert.equal(await guard.assessToolCall({ toolName: 'project_exec', args: {}, env: ENV, fetchImpl: fakeFetch({ e: 1 }, 500) }), null, 'fail-open');
});

test('skill picker: Choice over the catalogue + none; recommends above thresholds; records skill_route', async () => {
  const descriptors = [
    { id: 'academic_citation', description: 'Formatea citas APA/IEEE' },
    { id: 'scholarly_search', description: 'Busca papers en bases académicas' },
    { id: 'scheduling', description: 'Agenda reuniones' },
  ];
  const fetchImpl = fakeFetch({ model: 'jev-1.13.0', answers: {
    skill: { type: 'choice', choice: 'scholarly_search', probabilities: { scholarly_search: 0.62, academic_citation: 0.3, scheduling: 0.02, none: 0.06 }, confidence: 0.55 },
  }, usage: { input_tokens: 80, output_tokens: 0 } });
  const out = await picker.pickSkills({ query: 'busca papers sobre RLCD', descriptors, chatId: 'c1', env: ENV, fetchImpl, ledger });
  assert.deepEqual(out.recommended, ['scholarly_search', 'academic_citation']);
  assert.equal(out.top, 'scholarly_search');
  const q = fetchImpl.calls[0].body.questions.skill;
  assert.ok(q.criteria.none);
  assert.equal(Object.keys(q.criteria).length, 4);
  assert.equal(ledger.getDecision(out.decisionId).kind, 'skill_route');
  assert.equal(ledger.getDecision(out.decisionId).choice, 'skill:scholarly_search');

  const none = fakeFetch({ model: 'jev-1.13.0', answers: { skill: { type: 'choice', choice: 'none', probabilities: { none: 0.8, scheduling: 0.2 }, confidence: 0.7 } }, usage: {} });
  const o2 = await picker.pickSkills({ query: 'hola', descriptors, env: ENV, fetchImpl: none, ledger });
  assert.deepEqual(o2.recommended, []);
  assert.equal(await picker.pickSkills({ query: 'x', descriptors: [descriptors[0]], env: ENV, fetchImpl }), null, 'needs ≥2 skills');
  assert.equal(await picker.pickSkills({ query: 'x', descriptors, env: { ...ENV, SIRAGPT_RLCD_JEV_SKILL_PICKER: '0' }, fetchImpl }), null);
});

test('ledger kinds/labels and wiring: harness gate, agentic stream picker, run_skill outcome', () => {
  assert.ok(ledger.DECISION_KINDS.includes('tool_risk'));
  assert.ok(ledger.DECISION_KINDS.includes('skill_route'));
  assert.equal(ledger.OUTCOME_LABELS.guard_needed, 1);
  assert.equal(ledger.OUTCOME_LABELS.guard_unneeded, 0);
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const es = read('src/services/agent-harness/event-stream.js');
  assert.match(es, /guard\.assessToolCall\(\{/);
  assert.match(es, /meta\.permissionTier === 'confirm' \|\| protectedWrite \|\| jevConfirm/);
  assert.match(es, /recordGuardOutcome\(jevGuard, outcome\.decision/);
  assert.match(es, /emit\('tool_risk_assessed'/);
  const rat = read('src/services/agent-harness/run-agent-turn.js');
  assert.match(rat, /composerPermission, userQuery \}/);
  const acs = read('src/services/agentic-chat-stream.js');
  assert.match(acs, /userQuery: typeof userQuery === 'string' \? userQuery : null/);
  assert.match(acs, /skillPicker\.pickSkills\(\{/);
  const react = read('src/services/react-agent.js');
  assert.match(react, /MEDIA_TOOL_NAMES = new Set\(\['generate_image', 'edit_image', 'generate_video', 'generate_music', 'generate_speech'\]\)/);
  assert.match(react, /source: isMedia \? 'media_tool' : 'skill'/);
  const cfg = require('../src/services/rlcd/config').describe({});
  assert.ok(cfg.kinds.tool_risk && cfg.kinds.skill_route);
  assert.ok(cfg.thresholds.jevToolConfirm && cfg.flags.jevToolGuard && cfg.flags.jevSkillPicker);
});
