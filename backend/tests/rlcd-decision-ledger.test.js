'use strict';

// RLCD — reinforcement learning for calibrated decisions: every typed decision
// carries a confidence; outcomes are joined later; reliability bins give ECE /
// Brier and a calibrated probability that steers the execution lane.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ledger = require('../src/services/rlcd/decision-ledger');
const rlcd = require('../src/services/rlcd');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test.beforeEach(() => ledger.reset());

test('recordDecision validates input and stores a bounded, typed record', () => {
  assert.equal(ledger.recordDecision({ kind: '', choice: 'x', confidence: 0.5 }), null);
  assert.equal(ledger.recordDecision({ kind: 'model_route', choice: 'x', confidence: 'nope' }), null);
  const id = ledger.recordDecision({ kind: 'model_route', choice: 'grok-4.6', confidence: 1.7, signature: 'chat|moderate|grok-4.6', chatId: 'c1' });
  assert.ok(id);
  const d = ledger.getDecision(id);
  assert.equal(d.confidence, 1);
  assert.equal(d.kind, 'model_route');
  assert.equal(d.outcome, null);
  assert.equal(ledger.snapshot().byKind.model_route, 1);
});

test('calibrated() returns the raw confidence with no data and converges to the observed rate', () => {
  assert.deepEqual(ledger.calibrated('execution_lane', 0.9).calibrated, 0.9);
  // 20 decisions at 0.9 confidence that all failed → the bin is far below 0.9
  for (let i = 0; i < 20; i += 1) {
    const id = ledger.recordDecision({ kind: 'execution_lane', choice: 'plain', confidence: 0.9, chatId: `c${i}` });
    ledger.recordOutcome({ decisionIds: [id], outcome: 'failure', source: 'test' });
  }
  const cal = ledger.calibrated('execution_lane', 0.92);
  assert.equal(cal.samples, 20);
  assert.equal(cal.observed, 0);
  assert.equal(cal.reliable, true);
  assert.ok(cal.calibrated < 0.25, `expected shrink toward 0, got ${cal.calibrated}`);
  // a different bin is untouched
  assert.equal(ledger.calibrated('execution_lane', 0.3).calibrated, 0.3);
});

test('reliability report computes ECE, Brier and per-bin accuracy', () => {
  for (let i = 0; i < 10; i += 1) {
    const id = ledger.recordDecision({ kind: 'intent_triage', choice: 'execute', confidence: 0.8 });
    ledger.recordOutcome({ decisionIds: [id], outcome: i < 8 ? 'success' : 'failure' });
  }
  const r = ledger.reliabilityFor('intent_triage');
  assert.equal(r.samples, 10);
  assert.equal(r.accuracy, 0.8);
  assert.equal(r.ece, 0); // perfectly calibrated: 0.8 confidence, 80% success
  assert.equal(r.brier, Math.round(((8 * 0.04) + (2 * 0.64)) / 10 * 1000) / 1000);
  const bin = r.bins.find((b) => b.samples === 10);
  assert.deepEqual(bin.range, [0.8, 0.9]);
  assert.equal(bin.gap, 0);
});

test('outcomes join by messageId, by chat (last turn) or by ids; a later signal replaces the earlier one', () => {
  const a = ledger.recordDecision({ kind: 'model_route', choice: 'm', confidence: 0.7, chatId: 'chat1' });
  const b = ledger.recordDecision({ kind: 'compute_mode', choice: 'direct', confidence: 0.7, chatId: 'chat1' });
  ledger.markTurn('chat1', [a, b]);
  assert.equal(ledger.bindMessage([a, b], 'msg1'), 2);
  assert.equal(ledger.recordOutcome({ messageId: 'msg1', outcome: 'provider_failure', source: 'provider' }), 2);
  assert.equal(ledger.reliabilityFor('model_route').accuracy, 0);
  // thumb up later overrides the implicit failure without double counting
  assert.equal(ledger.recordOutcome({ messageId: 'msg1', outcome: 'liked', source: 'thumb' }), 2);
  assert.equal(ledger.reliabilityFor('model_route').samples, 1);
  assert.equal(ledger.reliabilityFor('model_route').accuracy, 1);
  // regenerate on the chat hits the last turn
  assert.equal(ledger.recordOutcome({ chatId: 'chat1', outcome: 'regenerated' }), 2);
  assert.equal(ledger.reliabilityFor('compute_mode').accuracy, 0);
  // unknown label / nothing to join
  assert.equal(ledger.recordOutcome({ messageId: 'nope', outcome: 'liked' }), 0);
  assert.equal(ledger.recordOutcome({ messageId: 'msg1', outcome: 'meh' }), 0);
  assert.equal(ledger.snapshot().outcomesUnmatched, 1);
});

test('snapshot/load round-trips the bins and prometheus text is never empty', () => {
  const id = ledger.recordDecision({ kind: 'model_route', choice: 'm', confidence: 0.55 });
  ledger.recordOutcome({ decisionIds: [id], outcome: 'success' });
  const snap = ledger.snapshot();
  ledger.reset();
  assert.equal(ledger.calibrated('model_route', 0.55).samples, 0);
  assert.equal(ledger.load(snap), true);
  assert.equal(ledger.calibrated('model_route', 0.55).samples, 1);
  const prom = ledger.toPrometheusText();
  assert.match(prom, /sira_rlcd_decisions_total 0/);
  assert.match(prom, /sira_rlcd_accuracy\{kind="model_route"\} 1/);
  ledger.reset();
  assert.match(ledger.toPrometheusText(), /sira_rlcd_ece 0/);
});

test('recordTurnDecisions derives confidences from triage ambiguity, routing score and difficulty', () => {
  const ids = rlcd.recordTurnDecisions({
    chatId: 'c9',
    triage: { action: 'execute', score: 0.12, source: 'heuristic' },
    cognitive: {
      intent: 'chat',
      difficulty: { bucket: 'moderate', score: 0.5 },
      routing: { selectedModel: 'grok-4.6', recommendedScore: 0.83, action: 'keep', changed: false },
      compute: { mode: 'direct' },
    },
    model: 'grok-4.6',
  });
  assert.equal(ids.length, 3);
  const [triage, route, compute] = ids.map((id) => ledger.getDecision(id));
  assert.equal(triage.kind, 'intent_triage');
  assert.equal(triage.confidence, 0.88);
  assert.equal(route.kind, 'model_route');
  assert.equal(route.confidence, 0.83);
  assert.equal(compute.kind, 'compute_mode');
  assert.equal(compute.confidence, 0.8);
  assert.equal(triage.signature, 'chat|moderate|grok-4.6');
  // the turn is joinable by chat right away (regenerate) …
  assert.equal(ledger.recordOutcome({ chatId: 'c9', outcome: 'regenerated' }), 3);
  // … and by message after persistence
  assert.equal(ledger.bindMessage(ids, 'm9'), 3);
  assert.equal(rlcd.recordThumb({ messageId: 'm9', feedback: 'liked', metadata: { rlcd: { decisions: ids } } }), 3);
});

test('execution lane: heuristics win; calibration forces the agentic loop only when reliable and confident', () => {
  const heuristic = rlcd.decideExecutionLane({ chatId: 'c1', heuristicAgentic: true, codeConfidence: 0.3, isCodeTask: false });
  assert.equal(heuristic.agentic, true);
  assert.equal(heuristic.forced, false);
  assert.equal(ledger.getDecision(heuristic.decisionId).choice, 'agentic');
  // no data: the raw confidence decides (0.98 ≥ 0.6) → forced
  const forced = rlcd.decideExecutionLane({ chatId: 'c2', heuristicAgentic: false, codeConfidence: 0.98, isCodeTask: true });
  assert.equal(forced.agentic, true);
  assert.equal(forced.forced, true);
  assert.equal(forced.reason, 'calibrated');
  // weak code signal stays plain
  const plain = rlcd.decideExecutionLane({ chatId: 'c3', heuristicAgentic: false, codeConfidence: 0.4, isCodeTask: true });
  assert.equal(plain.agentic, false);
  assert.equal(ledger.getDecision(plain.decisionId).choice, 'plain');
  assert.equal(ledger.getDecision(plain.decisionId).confidence, 0.6);
  // after many forced agentic turns fail, calibration stops forcing
  for (let i = 0; i < 30; i += 1) {
    const d = rlcd.decideExecutionLane({ chatId: `x${i}`, heuristicAgentic: false, codeConfidence: 0.98, isCodeTask: true });
    ledger.recordOutcome({ decisionIds: [d.decisionId], outcome: 'disliked' });
  }
  const learned = rlcd.decideExecutionLane({ chatId: 'c4', heuristicAgentic: false, codeConfidence: 0.98, isCodeTask: true });
  assert.equal(learned.forced, false);
  assert.ok(learned.calibrated < 0.6);
  // Calibration reacts fast: with PRIOR_WEIGHT=5 the 0.9-1.0 bin drops below
  // the 0.6 threshold after 4 failures, so only the first few turns were forced.
  const forcedCount = ledger.snapshot().lane.forced;
  assert.ok(forcedCount >= 2 && forcedCount < 31, `forced=${forcedCount}`);
  // kill switch
  const off = rlcd.decideExecutionLane({ chatId: 'c5', heuristicAgentic: false, codeConfidence: 0.98, isCodeTask: true, env: { SIRAGPT_RLCD_LANE_STEERING: '0' } });
  assert.equal(off.forced, false);
});

test('stats hides bins from non-admins and exposes them to admins', () => {
  const user = rlcd.stats({ admin: false });
  assert.equal(user.enabled, true);
  assert.ok(Array.isArray(user.reliability));
  assert.equal(user.reliabilityBins, undefined);
  const admin = rlcd.stats({ admin: true });
  assert.ok(Array.isArray(admin.reliabilityBins));
  assert.ok(admin.lane);
});

test('generate route, thumbs, mount and /metrics are wired', () => {
  const ai = read('src/routes/ai.js');
  assert.match(ai, /rlcd\.recordTurnDecisions\(\{/);
  assert.match(ai, /rlcd\.decideExecutionLane\(\{/);
  assert.match(ai, /\(shouldRunAgentic \|\| __rlcdLane\.forced === true \|\| documentEditRequested \|\| createDocRequested\)/);
  assert.match(ai, /outcome: 'regenerated', source: 'regenerate'/);
  assert.match(ai, /source: 'faithfulness'/);
  assert.match(ai, /outcome: 'constraint_violation', source: 'constraints'/);
  assert.match(ai, /code === 'ttfb_abort' \? 'ttfb_abort' : 'provider_failure', source: 'provider'/);
  assert.match(ai, /rlcd: \{ decisions: req\._rlcdDecisionIds\.slice\(0, 8\)/);
  assert.match(ai, /\.\.\.\(actualModel \? \{ model: actualModel \} : \{\}\)/);
  assert.match(ai, /ledger\.bindMessage\(safeExtraMetadata\.rlcd\.decisions, assistantMessage\.id\)/);
  const chats = read('src/routes/chats.js');
  assert.match(chats, /require\('\.\.\/services\/rlcd'\)\.recordThumb\(\{ messageId: message\.id, feedback, metadata: meta \}\)/);
  const index = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(index, /app\.use\('\/api\/rlcd', rlcdRoutes\)/);
  const obs = read('src/services/ai/generate-request-observability.js');
  assert.match(obs, /'rlcd\.decisions_recorded',/);
  assert.match(obs, /'rlcd\.lane_decided',/);
  const { formatProcessMetricsExposition } = require('../src/services/observability/process-metrics-exposition');
  assert.match(formatProcessMetricsExposition(), /sira_rlcd_decisions_total/);
  const routeSrc = read('src/routes/rlcd.js');
  assert.match(routeSrc, /router\.get\('\/stats', authenticateToken/);
});
