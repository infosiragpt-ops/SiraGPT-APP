'use strict';

/**
 * RLCD phase 1 — persistence without a migration, reviewable config,
 * recent-decisions ring and the admin route surface.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ledger = require('../src/services/rlcd/decision-ledger');
const persistence = require('../src/services/rlcd/persistence');
const config = require('../src/services/rlcd/config');
const rlcd = require('../src/services/rlcd');

function fakePrisma(initial = null) {
  const rows = new Map();
  if (initial) rows.set(initial.key, { key: initial.key, value: initial.value });
  const calls = { upsert: 0, findUnique: 0 };
  return {
    rows,
    calls,
    systemSettings: {
      findUnique: async ({ where }) => { calls.findUnique += 1; return rows.get(where.key) || null; },
      upsert: async ({ where, update, create }) => {
        calls.upsert += 1;
        const cur = rows.get(where.key);
        if (cur) { cur.value = update.value; return cur; }
        rows.set(where.key, { key: create.key, value: create.value });
        return rows.get(where.key);
      },
    },
  };
}

test.beforeEach(() => { ledger.reset(); persistence.resetForTests(); });

test('config.describe: single reviewable place, env overrides are flagged', () => {
  const d = config.describe({});
  assert.deepEqual(Object.keys(d.kinds), ['intent_triage', 'execution_lane', 'model_route', 'compute_mode', 'media_intent', 'tool_risk', 'skill_route']);
  assert.equal(d.thresholds.laneThreshold.value, 0.6);
  assert.equal(d.thresholds.mediaAsk.value, 0.35);
  assert.equal(d.flags.jev.value, false, 'jev is off without a key');
  const o = config.describe({ SIRAGPT_RLCD_LANE_THRESHOLD: '0.7', TYPESAFE_API_KEY: 'k', SIRAGPT_RLCD_PERSIST_INTERVAL_MS: '60000' });
  assert.equal(o.thresholds.laneThreshold.value, 0.7);
  assert.equal(o.thresholds.laneThreshold.overridden, true);
  assert.equal(o.flags.jev.value, true);
  assert.equal(o.persistence.intervalMs, 60000);
  assert.equal(o.persistence.key, 'rlcd.ledger.v2');
  for (const k of Object.keys(d.kinds)) assert.ok(ledger.DECISION_KINDS.includes(k), `${k} documented but unknown to the ledger`);
  for (const k of ledger.DECISION_KINDS) assert.ok(d.kinds[k], `${k} missing from config docs`);
});

test('ledger: persistable snapshot round-trips bins and counters; recent ring reports outcomes', () => {
  const a = ledger.recordDecision({ kind: 'media_intent', choice: 'force:image', confidence: 0.9, chatId: 'chat-1', meta: { source: 'jev' } });
  const b = ledger.recordDecision({ kind: 'execution_lane', choice: 'agentic', confidence: 0.7, chatId: 'chat-1' });
  ledger.recordOutcome({ decisionIds: [a], outcome: 'tool_success', source: 'media_tool' });
  ledger.recordOutcome({ decisionIds: [b], outcome: 'disliked', source: 'thumb' });
  ledger.noteLane({ consulted: true, forced: true });
  assert.equal(ledger.isDirty(), true);
  const p = ledger.persistable();
  assert.equal(p.version, 2);
  assert.equal(p.counters.decisions, 2);
  assert.equal(p.counters.outcomes, 2);
  assert.equal(p.counters.laneForced, 1);
  assert.equal(p.bins.media_intent.length, ledger.BIN_COUNT);

  const recent = ledger.recentDecisions({ limit: 10 });
  assert.equal(recent.length, 2);
  assert.equal(recent[0].kind, 'execution_lane', 'newest first');
  assert.equal(recent[0].outcome.label, 'disliked');
  assert.equal(recent[1].source, 'jev');
  assert.equal(recent[1].chatId, 'chat-1…');
  assert.equal(ledger.recentDecisions({ kind: 'media_intent' }).length, 1);

  ledger.reset();
  assert.equal(ledger.snapshot().decisions, 0);
  assert.equal(ledger.load(p), true);
  const s = ledger.snapshot();
  assert.equal(s.decisions, 2);
  assert.equal(s.byOutcome.tool_success, 1);
  assert.equal(s.lane.forced, 1);
  const rel = s.reliability.find((r) => r.kind === 'media_intent');
  assert.equal(rel.samples, 1);
  assert.equal(rel.accuracy, 1);
  assert.equal(ledger.isDirty(), false, 'a freshly loaded ledger is clean');
  assert.equal(ledger.calibrated('media_intent', 0.9).samples, 1);
});

test('persistence: restore at boot, skip clean saves, force-save, and fail-open on DB errors', async () => {
  const env = { SIRAGPT_RLCD_PERSIST: '1' };
  const empty = fakePrisma();
  assert.deepEqual(await persistence.restore({ prisma: empty, env }), { ok: true, reason: 'empty' });
  assert.equal((await persistence.save({ prisma: empty, env })).reason, 'clean');
  ledger.recordDecision({ kind: 'model_route', choice: 'grok', confidence: 0.8 });
  const saved = await persistence.save({ prisma: empty, env });
  assert.equal(saved.reason, 'saved');
  assert.equal(saved.decisions, 1);
  assert.equal(empty.calls.upsert, 1);
  assert.equal((await persistence.save({ prisma: empty, env })).reason, 'clean', 'nothing changed → no write');
  assert.equal((await persistence.save({ prisma: empty, env, force: true })).reason, 'saved');

  const stored = empty.rows.get('rlcd.ledger.v2').value;
  ledger.reset();
  const again = fakePrisma({ key: 'rlcd.ledger.v2', value: stored });
  const r = await persistence.restore({ prisma: again, env });
  assert.equal(r.reason, 'restored');
  assert.equal(ledger.snapshot().decisions, 1);
  assert.equal(persistence.status().restoredDecisions, 1);

  assert.equal((await persistence.save({ prisma: empty, env: { SIRAGPT_RLCD_PERSIST: '0' } })).reason, 'disabled');
  const broken = { systemSettings: { findUnique: async () => { throw new Error('db down'); }, upsert: async () => { throw new Error('db down'); } } };
  ledger.recordDecision({ kind: 'model_route', choice: 'x', confidence: 0.5 });
  const failed = await persistence.save({ prisma: broken, env });
  assert.equal(failed.ok, false);
  assert.match(persistence.status().lastError, /db down/);
  assert.equal((await persistence.restore({ prisma: broken, env })).ok, false);
});

test('persistence.start registers the shutdown flush and schedules the interval', async () => {
  const env = { SIRAGPT_RLCD_PERSIST: '1', SIRAGPT_RLCD_PERSIST_INTERVAL_MS: '10000' };
  const prisma = fakePrisma();
  const registered = [];
  const shutdownRegistry = { register: (name, fn, t) => { registered.push({ name, fn, t }); return () => {}; } };
  const st = await persistence.start({ prisma, env, shutdownRegistry, logger: { info() {}, warn() {} } });
  assert.equal(st.started, true);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, 'rlcd_ledger_flush');
  ledger.recordDecision({ kind: 'compute_mode', choice: 'deep', confidence: 0.6 });
  const out = await registered[0].fn();
  assert.equal(out.reason, 'saved');
  persistence.stop();
});

test('rlcd.stats(admin) exposes config + persistence; route file wires decisions/persist and boot wiring exists', () => {
  const s = rlcd.stats({ admin: true });
  assert.ok(s.config && s.config.thresholds.mediaForce);
  assert.ok(s.persistence && 'saves' in s.persistence);
  assert.equal('config' in rlcd.stats({ admin: false }), false, 'non-admins do not see config');
  assert.equal(typeof rlcd.recentDecisions, 'function');
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'rlcd.js'), 'utf8');
  assert.match(route, /router\.get\('\/decisions', authenticateToken/);
  assert.match(route, /router\.post\('\/persist', authenticateToken/);
  assert.match(route, /admin_required/);
  const boot = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(boot, /require\('\.\/src\/services\/rlcd\/persistence'\)\s*\.start\(\{ prisma, shutdownRegistry, logger \}\)/);
  const api = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'api.ts'), 'utf8');
  assert.match(api, /getRlcdStats\(\)/);
  assert.match(api, /postRlcdPersist\(\)/);
  const sidebar = fs.readFileSync(path.join(__dirname, '..', '..', 'components', 'admin-sidebar.tsx'), 'utf8');
  assert.match(sidebar, /url: "\/admin\/rlcd"/);
  assert.ok(fs.existsSync(path.join(__dirname, '..', '..', 'app', 'admin', 'rlcd', 'page.tsx')));
});
