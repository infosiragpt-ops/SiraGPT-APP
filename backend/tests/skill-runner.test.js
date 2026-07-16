'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const runner = require('../src/services/agents/skill-runner');

// Deterministic mock of system D (services/skills) so tests don't depend on the
// real filesystem skills' internals. Mimics the sandbox capability filter.
function mockD() {
  const skills = new Map([
    ['echo', { id: 'echo', description: 'Echo a message', capabilities: [], params: { type: 'object', required: ['msg'], properties: { msg: { type: 'string' } }, additionalProperties: false }, execute: async (a) => ({ echoed: a.msg }) }],
    ['scholar', { id: 'scholar', description: 'Scholarly search', capabilities: ['net:outbound'], params: null, execute: async () => ({ hits: 3 }) }],
    ['sched', { id: 'sched', description: 'Schedule a job', capabilities: ['schedule'], params: null, execute: async () => ({ scheduled: true }) }],
    ['boom', { id: 'boom', description: 'Always throws', capabilities: [], params: null, execute: async () => { throw new Error('kaboom'); } }],
    ['source_list', { id: 'source_list', description: 'List sources', capabilities: [], params: null, execute: async () => ({ sources: [{ doi: '10.1/a' }, { doi: null }, { doi: '10.1/b' }] }) }],
    ['collect', { id: 'collect', description: 'Collect DOI values', capabilities: [], params: { type: 'object', required: ['dois'], properties: { dois: { type: 'array' } }, additionalProperties: false }, execute: async (a) => ({ dois: a.dois }) }],
  ]);
  const SANDBOX = new Set(['llm:call', 'net:outbound:llm', 'fs:read', 'agent:read']);
  return {
    get: () => ({ skills, errors: [] }),
    createPolicy: ({ mode }) => ({ mode }),
    wrapSkillsWithPolicy: (list, pol) => {
      const visible = [];
      const hidden = [];
      for (const s of list) {
        const denied = pol.mode === 'sandbox' && (s.capabilities || []).some((c) => !SANDBOX.has(c));
        if (denied) hidden.push({ id: s.id, reason: 'capability_not_granted' });
        else visible.push({ ...s });
      }
      return { skills: visible, hidden, counters: {} };
    },
  };
}
const D = mockD();

describe('policyModeForClearance', () => {
  test('enterprise/paid → main, others → sandbox', () => {
    assert.equal(runner.policyModeForClearance('enterprise'), 'main');
    assert.equal(runner.policyModeForClearance('paid'), 'main');
    assert.equal(runner.policyModeForClearance('authenticated'), 'sandbox');
    assert.equal(runner.policyModeForClearance(null), 'sandbox');
  });
});

describe('runSkill', () => {
  test('runs a skill and returns its result', async () => {
    const r = await runner.runSkill('echo', { msg: 'hola' }, { clearance: 'enterprise' }, D);
    assert.equal(r.ok, true);
    assert.deepEqual(r.result, { echoed: 'hola' });
  });

  test('validates args against the skill schema', async () => {
    const r = await runner.runSkill('echo', {}, { clearance: 'enterprise' }, D);
    assert.equal(r.ok, false);
    assert.match(r.error, /invalid_args/);
  });

  test('policy denies a high-capability skill in sandbox (non-enterprise)', async () => {
    const r = await runner.runSkill('sched', {}, { clearance: 'authenticated' }, D);
    assert.equal(r.ok, false);
    assert.match(r.error, /skill_denied/);
  });

  test('same skill is allowed for enterprise (main mode)', async () => {
    const r = await runner.runSkill('sched', {}, { clearance: 'enterprise' }, D);
    assert.equal(r.ok, true);
  });

  test('unknown skill → error', async () => {
    const r = await runner.runSkill('nope', {}, { clearance: 'enterprise' }, D);
    assert.equal(r.ok, false);
    assert.match(r.error, /unknown_skill/);
  });

  test('empty id → missing_skill_id', async () => {
    const r = await runner.runSkill('', {}, {}, D);
    assert.match(r.error, /missing_skill_id/);
  });

  test('a throwing handler is caught (never throws)', async () => {
    const r = await runner.runSkill('boom', {}, { clearance: 'enterprise' }, D);
    assert.equal(r.ok, false);
    assert.match(r.error, /kaboom/);
  });

  test('subsystem unavailable → graceful error', async () => {
    const r = await runner.runSkill('echo', {}, {}, { get: () => ({ skills: null }) });
    assert.equal(r.ok, false);
    assert.match(r.error, /unavailable/);
  });

  test('execution allow-list blocks an otherwise policy-visible skill', async () => {
    const r = await runner.runSkill('sched', {}, {
      clearance: 'enterprise',
      allowedSkillIds: ['echo'],
    }, D);
    assert.equal(r.ok, false);
    assert.match(r.error, /skill_not_allowed/);
  });

  test('throws AbortError when the caller signal is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => runner.runSkill('echo', { msg: 'late' }, { clearance: 'enterprise', signal: controller.signal }, D),
      { name: 'AbortError', code: 'ABORT_ERR' },
    );
  });
});

describe('runSkillPipeline', () => {
  test('runs sequential skills and passes references from prior results', async () => {
    const out = await runner.runSkillPipeline([
      { skillId: 'echo', args: { msg: 'hola' } },
      { skillId: 'echo', args: { msg: { $fromStep: 0, path: ['result', 'echoed'] } } },
    ], { clearance: 'enterprise' }, D);
    assert.equal(out.ok, true);
    assert.equal(out.completed, 2);
    assert.deepEqual(out.results[1].result, { echoed: 'hola' });
  });

  test('maps and compacts array values from an earlier skill result', async () => {
    const out = await runner.runSkillPipeline([
      { skillId: 'source_list', args: {} },
      { skillId: 'collect', args: { dois: { $fromStep: 0, path: ['result', 'sources'], mapPath: ['doi'], compact: true } } },
    ], { clearance: 'enterprise' }, D);
    assert.equal(out.ok, true);
    assert.deepEqual(out.results[1].result, { dois: ['10.1/a', '10.1/b'] });
  });

  test('stops on the first failed step by default', async () => {
    const out = await runner.runSkillPipeline([
      { skillId: 'boom', args: {} },
      { skillId: 'echo', args: { msg: 'should not run' } },
    ], { clearance: 'enterprise' }, D);
    assert.equal(out.ok, false);
    assert.equal(out.completed, 1);
    assert.equal(out.failed, 1);
    assert.equal(out.stoppedAt, 0);
    assert.match(out.results[0].error, /kaboom/);
  });

  test('can continue after a failed independent step', async () => {
    const out = await runner.runSkillPipeline([
      { skillId: 'boom', args: {} },
      { skillId: 'echo', args: { msg: 'continua' } },
    ], { clearance: 'enterprise' }, D, null, { continueOnError: true });
    assert.equal(out.ok, false);
    assert.equal(out.completed, 2);
    assert.equal(out.failed, 1);
    assert.equal(out.stoppedAt, null);
    assert.deepEqual(out.results[1].result, { echoed: 'continua' });
  });

  test('rejects references to future, failed, or dangerous paths', async () => {
    const future = await runner.runSkillPipeline([
      { skillId: 'echo', args: { msg: { $fromStep: 1, path: ['result'] } } },
      { skillId: 'echo', args: { msg: 'later' } },
    ], { clearance: 'enterprise' }, D);
    assert.equal(future.ok, false);
    assert.match(future.results[0].error, /invalid_reference_step/);

    const failed = await runner.runSkillPipeline([
      { skillId: 'boom', args: {} },
      { skillId: 'echo', args: { msg: { $fromStep: 0, path: ['result'] } } },
    ], { clearance: 'enterprise' }, D, null, { continueOnError: true });
    assert.match(failed.results[1].error, /invalid_reference_failed_step/);

    const dangerous = await runner.runSkillPipeline([
      { skillId: 'echo', args: { msg: 'x' } },
      { skillId: 'echo', args: { msg: { $fromStep: 0, path: ['result', '__proto__'] } } },
    ], { clearance: 'enterprise' }, D);
    assert.match(dangerous.results[1].error, /path_forbidden_segment/);
  });

  test('applies the same allow-list and policy gates to every step', async () => {
    const deniedByAllowList = await runner.runSkillPipeline([
      { skillId: 'echo', args: { msg: 'ok' } },
      { skillId: 'sched', args: {} },
    ], { clearance: 'enterprise', allowedSkillIds: ['echo'] }, D);
    assert.equal(deniedByAllowList.ok, false);
    assert.match(deniedByAllowList.results[1].error, /skill_not_allowed/);

    const deniedByPolicy = await runner.runSkillPipeline([
      { skillId: 'echo', args: { msg: 'ok' } },
      { skillId: 'sched', args: {} },
    ], { clearance: 'authenticated' }, D);
    assert.match(deniedByPolicy.results[1].error, /skill_denied/);
  });

  test('validates pipeline length and supports trusted plugin skills', async () => {
    const tooShort = await runner.runSkillPipeline([{ skillId: 'echo', args: { msg: 'x' } }], { clearance: 'enterprise' }, D);
    assert.equal(tooShort.ok, false);
    assert.match(tooShort.error, /steps_out_of_range/);

    const pluginSkills = new Map([
      ['plugin_lookup', {
        id: 'plugin_lookup',
        description: 'Lookup from plugin',
        capabilities: [],
        params: { type: 'object', required: ['q'], properties: { q: { type: 'string' } } },
        execute: async ({ q }) => ({ found: q }),
      }],
    ]);
    const out = await runner.runSkillPipeline([
      { skillId: 'plugin_lookup', args: { q: 'paper' } },
      { skillId: 'echo', args: { msg: { $fromStep: 0, path: ['result', 'found'] } } },
    ], { clearance: 'enterprise' }, D, pluginSkills);
    assert.equal(out.ok, true);
    assert.deepEqual(out.results[1].result, { echoed: 'paper' });
  });

  test('throws AbortError when cancelled before pipeline execution', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => runner.runSkillPipeline([
        { skillId: 'echo', args: { msg: 'a' } },
        { skillId: 'echo', args: { msg: 'b' } },
      ], { clearance: 'enterprise', signal: controller.signal }, D),
      { name: 'AbortError', code: 'ABORT_ERR' },
    );
  });
});

describe('listSkillDescriptors', () => {
  test('sandbox clearance hides high-capability skills', () => {
    const list = runner.listSkillDescriptors({ clearance: 'authenticated' }, D);
    const ids = list.map((s) => s.id);
    assert.ok(ids.includes('echo'));
    assert.ok(!ids.includes('sched')); // schedule denied in sandbox
  });
  test('enterprise sees all', () => {
    const ids = runner.listSkillDescriptors({ clearance: 'enterprise' }, D).map((s) => s.id);
    assert.ok(ids.includes('sched'));
  });
  test('allow-list exposes only configured skills', () => {
    const ids = runner.listSkillDescriptors({
      clearance: 'enterprise',
      allowedSkillIds: ['echo', 'scholar'],
    }, D).map((s) => s.id);
    assert.deepEqual(ids.sort(), ['echo', 'scholar']);
  });
});

describe('buildRunSkillTool', () => {
  test('builds a single run_skill tool with a skill list', () => {
    const tool = runner.buildRunSkillTool({ ctx: { clearance: 'enterprise' } }, D);
    assert.equal(tool.name, 'run_skill');
    assert.match(tool.description, /echo/);
    assert.match(tool.description, /sched/);
    assert.ok(tool.parameters.required.includes('skillId'));
    assert.equal(typeof tool.execute, 'function');
  });

  test('execute dispatches to runSkill', async () => {
    const tool = runner.buildRunSkillTool({ ctx: { clearance: 'enterprise' } }, D);
    const out = await tool.execute({ skillId: 'echo', args: { msg: 'hi' } }, { clearance: 'enterprise' });
    assert.equal(out.ok, true);
    assert.deepEqual(out.result, { echoed: 'hi' });
  });

  test('returns null when no skills are available', () => {
    const empty = { get: () => ({ skills: new Map() }), createPolicy: () => ({ mode: 'sandbox' }), wrapSkillsWithPolicy: () => ({ skills: [], hidden: [] }) };
    assert.equal(runner.buildRunSkillTool({ ctx: {} }, empty), null);
  });

  test('advertises and enforces only allowed skills, with recommendations first', async () => {
    const tool = runner.buildRunSkillTool({
      ctx: { clearance: 'enterprise' },
      allowedSkillIds: ['echo', 'sched'],
      recommendedSkillIds: ['sched'],
    }, D);
    assert.deepEqual(tool.parameters.properties.skillId.enum, ['sched', 'echo']);
    assert.match(tool.description, /RECOMENDADA sched/);
    assert.match(tool.description, /msg\*:string/);
    const denied = await tool.execute({ skillId: 'scholar', args: {} }, { clearance: 'enterprise' });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /skill_not_allowed/);
  });

  test('merges a plugin skill at lower precedence and executes it through the same policy', async () => {
    const pluginSkills = new Map([
      ['plugin_lookup', {
        id: 'plugin_lookup',
        description: 'Lookup from a trusted plugin',
        capabilities: [],
        params: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
        execute: async ({ q }) => ({ found: q }),
      }],
    ]);
    const tool = runner.buildRunSkillTool({ ctx: { clearance: 'enterprise' }, pluginSkills }, D);
    assert.ok(tool.parameters.properties.skillId.enum.includes('plugin_lookup'));
    assert.deepEqual(tool.__pluginSkillIds, ['plugin_lookup']);
    const out = await tool.execute({ skillId: 'plugin_lookup', args: { q: 'paper' } }, {});
    assert.deepEqual(out, { ok: true, skillId: 'plugin_lookup', result: { found: 'paper' } });
  });

  test('keeps native skills on collisions and rejects malformed plugin skills', async () => {
    const pluginSkills = new Map([
      ['echo', {
        id: 'echo',
        description: 'Must not replace core echo',
        capabilities: [],
        params: null,
        execute: async () => ({ replaced: true }),
      }],
      ['malformed', { id: 'malformed', capabilities: [] }],
    ]);
    const tool = runner.buildRunSkillTool({ ctx: { clearance: 'enterprise' }, pluginSkills }, D);
    assert.deepEqual(tool.__pluginSkillConflicts, ['echo']);
    assert.deepEqual(tool.__invalidPluginSkillIds, ['malformed']);
    const out = await tool.execute({ skillId: 'echo', args: { msg: 'native' } }, {});
    assert.deepEqual(out.result, { echoed: 'native' });
  });

  test('applies sandbox capability policy to plugin skills', async () => {
    const pluginSkills = new Map([
      ['plugin_schedule', {
        id: 'plugin_schedule',
        description: 'Privileged plugin skill',
        capabilities: ['schedule'],
        params: null,
        execute: async () => ({ scheduled: true }),
      }],
    ]);
    const sandbox = runner.buildRunSkillTool({ ctx: { clearance: 'authenticated' }, pluginSkills }, D);
    assert.ok(!sandbox.parameters.properties.skillId.enum.includes('plugin_schedule'));
    const enterprise = runner.buildRunSkillTool({ ctx: { clearance: 'enterprise' }, pluginSkills }, D);
    assert.ok(enterprise.parameters.properties.skillId.enum.includes('plugin_schedule'));
  });
});

describe('buildRunSkillPipelineTool', () => {
  test('builds and executes the pipeline tool', async () => {
    const tool = runner.buildRunSkillPipelineTool({ ctx: { clearance: 'enterprise' } }, D);
    assert.equal(tool.name, 'run_skill_pipeline');
    assert.equal(tool.parameters.properties.steps.minItems, runner.PIPELINE_MIN_STEPS);
    assert.ok(tool.parameters.properties.steps.items.properties.skillId.enum.includes('echo'));
    const out = await tool.execute({
      steps: [
        { skillId: 'echo', args: { msg: 'hi' } },
        { skillId: 'echo', args: { msg: { $fromStep: 0, path: ['result', 'echoed'] } } },
      ],
    }, { clearance: 'enterprise' });
    assert.equal(out.ok, true);
    assert.deepEqual(out.results[1].result, { echoed: 'hi' });
  });
});

describe('real system D — smoke', () => {
  test('listSkillDescriptors loads the real skills for enterprise', () => {
    const list = runner.listSkillDescriptors({ clearance: 'enterprise' });
    assert.ok(Array.isArray(list));
    assert.ok(list.length >= 5, `expected real skills, got ${list.length}`);
    assert.ok(list.every((s) => typeof s.id === 'string'));
  });
});
