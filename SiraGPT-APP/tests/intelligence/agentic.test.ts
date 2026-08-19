import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  createAgenticExecutor,
  type Planner,
  type Reflector,
} from '../../server/intelligence/agentic/state-machine';
import type { ToolDescriptor, ToolRuntime } from '../../server/intelligence/ports';

function tool(name: string, readOnly = true): ToolDescriptor {
  return { name, description: `${name} tool`, inputSchema: z.any(), readOnly };
}

function recordingRuntime(): { runtime: ToolRuntime; invoked: string[] } {
  const invoked: string[] = [];
  const runtime: ToolRuntime = {
    invoke: async (call) => {
      invoked.push(call.tool);
      return { tool: call.tool, ok: true, output: `out-${call.tool}` };
    },
  };
  return { runtime, invoked };
}

describe('intelligence/agentic', () => {
  it('runs plan → execute → reflect → finalize and completes', async () => {
    const exec = createAgenticExecutor();
    const { runtime, invoked } = recordingRuntime();
    const result = await exec.run({
      goal: 'use search to find primes',
      tools: [tool('search')],
      runtime,
    });
    assert.equal(result.completed, true);
    assert.ok(invoked.includes('search'));
    const phases = result.steps.map((s) => s.phase);
    assert.ok(phases.includes('plan'));
    assert.ok(phases.includes('execute'));
    assert.ok(phases.includes('finalize'));
    assert.ok(result.output.includes('search'));
  });

  it('executes read-only tools in parallel', async () => {
    const exec = createAgenticExecutor();
    const { runtime } = recordingRuntime();
    const result = await exec.run({
      goal: 'use search and lookup together',
      tools: [tool('search'), tool('lookup')],
      runtime,
    });
    const execStep = result.steps.find((s) => s.phase === 'execute');
    assert.equal(execStep?.toolResults?.length, 2);
  });

  it('records a failed tool result and still finalizes', async () => {
    const exec = createAgenticExecutor();
    const runtime: ToolRuntime = {
      invoke: async () => {
        throw new Error('tool exploded');
      },
    };
    const result = await exec.run({ goal: 'use search', tools: [tool('search')], runtime });
    const execStep = result.steps.find((s) => s.phase === 'execute');
    assert.equal(execStep?.toolResults?.[0].ok, false);
    assert.ok(result.output.length > 0);
  });

  it('respects maxSteps when planner never finishes', async () => {
    const neverDonePlanner: Planner = {
      plan: () => ({ toolCalls: [{ tool: 'search', args: {} }], done: false }),
    };
    const neverDoneReflector: Reflector = { reflect: () => ({ done: false }) };
    const exec = createAgenticExecutor({
      planner: neverDonePlanner,
      reflector: neverDoneReflector,
    });
    const { runtime } = recordingRuntime();
    const result = await exec.run({
      goal: 'loop forever',
      tools: [tool('search')],
      runtime,
      maxSteps: 2,
    });
    assert.equal(result.completed, false);
    assert.equal(result.reason, 'max_steps_reached');
  });
});
