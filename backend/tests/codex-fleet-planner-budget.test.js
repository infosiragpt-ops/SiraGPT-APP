'use strict';

// The fleet planner answers with ONE JSON document inside a bounded token
// budget. Asking it for the whole fleet size guaranteed a truncated reply that
// failed to parse, so every large fleet silently degraded to the generic
// fallback DAG.
//
// Production incident: a 300-agent fleet asked to "build a working task panel"
// planned "investigate competitors / audit CRM / triage inbox" busywork —
// requesting MORE agents made the plan WORSE, which is exactly backwards.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fleet = require('../src/services/codex/fleet-orchestrator');

function plannerSpy({ taskCount = 12, reply = null } = {}) {
  const seen = {};
  const fn = async ({ messages, maxTokens }) => {
    seen.target = Number(/Número objetivo de tareas: (\d+)/.exec(messages[1].content)?.[1]);
    seen.maxTokens = maxTokens;
    if (reply !== null) return { content: reply };
    return {
      content: JSON.stringify({
        tasks: Array.from({ length: taskCount }, (_, i) => ({
          id: `task-${i}`,
          title: `Tarea ${i}`,
          description: 'detalle',
          departmentId: 'software_landing',
          role: i % 4 === 0 ? 'writer' : 'read-only',
          dependsOn: [],
          acceptance: ['verificable'],
        })),
      }),
    };
  };
  return { fn, seen };
}

test('a huge fleet still asks the planner for a compact DAG', async () => {
  const { fn, seen } = plannerSpy();
  await fleet.planFleetTasks({ objective: 'construir panel', planner: fn, desiredTasks: 300 });
  assert.ok(seen.target <= 24, `planner asked for ${seen.target}; must stay a compact DAG`);
  assert.ok(seen.maxTokens >= 6_000, 'reply budget must fit the DAG it asks for');
});

test('a large fleet keeps a REAL planner DAG instead of the generic fallback', async () => {
  const { fn } = plannerSpy();
  const out = await fleet.planFleetTasks({ objective: 'construir panel', planner: fn, desiredTasks: 300 });
  assert.notEqual(out.source, 'fallback', 'the objective-specific plan must survive');
  assert.equal(out.plannerError, null);
  assert.match(out.source, /^planner/);
});

test('logical capacity is still honoured — 300 agents means ~300 tasks', async () => {
  const { fn } = plannerSpy();
  const out = await fleet.planFleetTasks({ objective: 'construir panel', planner: fn, desiredTasks: 300 });
  assert.ok(out.tasks.length >= 300, `fleet padded to ${out.tasks.length}; expected >= 300`);
});

test('a small fleet asks for exactly what it needs, never more', async () => {
  const { fn, seen } = plannerSpy({ taskCount: 5 });
  const out = await fleet.planFleetTasks({ objective: 'arreglar bug', planner: fn, desiredTasks: 6 });
  assert.equal(seen.target, 6, 'small fleets are not inflated to the DAG cap');
  assert.notEqual(out.source, 'fallback');
});

test('an unparseable planner reply still degrades to the fallback DAG', async () => {
  const { fn } = plannerSpy({ reply: 'lo siento, no puedo' });
  // The fallback builds from the company plan, which the route always supplies.
  const companyPlan = {
    executiveSummary: 'Operar la empresa',
    workstreams: [
      { id: 'software_landing', title: 'Producto', tasks: [{ title: 'Construir panel', output: 'app funcional' }] },
    ],
  };
  const out = await fleet.planFleetTasks({ objective: 'construir panel', planner: fn, companyPlan, desiredTasks: 50 });
  assert.equal(out.source, 'fallback', 'a broken planner must not crash the fleet');
  assert.match(String(out.plannerError), /fleet_planner_tasks_required/);
  assert.ok(out.tasks.length > 0, 'the fallback still produces runnable work');
});
