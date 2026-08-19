/**
 * Tests for sub-agent-orchestrator.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SubAgentOrchestrator, SubAgentError, createOrchestrator } = require('../src/services/agents/sub-agent-orchestrator');

describe('SubAgentOrchestrator', () => {
  describe('decompose', () => {
    it('returns single task for empty goal', () => {
      const orch = new SubAgentOrchestrator();
      const tasks = orch.decompose('');
      assert.strictEqual(tasks.length, 1);
    });

    it('returns single task for short goal', () => {
      const orch = new SubAgentOrchestrator();
      const tasks = orch.decompose('Hello world');
      assert.strictEqual(tasks.length, 1);
    });

    it('splits numbered list into tasks', () => {
      const orch = new SubAgentOrchestrator();
      const tasks = orch.decompose('1. Research the topic\n2. Write summary\n3. Format output');
      assert.ok(tasks.length >= 2);
    });

    it('splits bullet list into tasks', () => {
      const orch = new SubAgentOrchestrator();
      const tasks = orch.decompose('- Check weather\n- Plan route\n- Pack bags');
      assert.ok(tasks.length >= 2);
    });

    it('respects maxSubAgents cap', () => {
      const orch = new SubAgentOrchestrator({ maxSubAgents: 2 });
      const goal = Array.from({ length: 10 }, (_, i) => `${i + 1}. Task ${i + 1}`).join('\n');
      const tasks = orch.decompose(goal);
      assert.ok(tasks.length <= 2);
    });

    it('deduplicates near-identical goals', () => {
      const orch = new SubAgentOrchestrator({ maxSubAgents: 5 });
      const tasks = orch.decompose('1. Do Research\n2. Do Research  \n3. Do Research');
      assert.ok(tasks.length <= 2);
    });
  });

  describe('orchestrate', () => {
    it('runs single task successfully', async () => {
      let callCount = 0;
      const orch = new SubAgentOrchestrator({
        runSubAgent: async (goal) => {
          callCount++;
          return { answer: `Result: ${goal}`, steps: [{ tool: 'think', output: 'done' }], stoppedReason: 'completed' };
        },
      });
      const result = await orch.orchestrate('Simple query', { userId: 1 });
      assert.strictEqual(callCount, 1);
      assert.ok(result.answer.includes('Simple query'));
      assert.strictEqual(result.stoppedReason, 'completed');
    });

    it('runs multiple sub-agents in parallel', async () => {
      const callOrder = [];
      const orch = new SubAgentOrchestrator({
        maxSubAgents: 4,
        runSubAgent: async (goal) => {
          await new Promise(r => setTimeout(r, Math.random() * 10));
          callOrder.push(goal.slice(0, 20));
          return { answer: `Result: ${goal}`, steps: [], stoppedReason: 'completed' };
        },
      });
      const result = await orch.orchestrate('1. Research data\n2. Analyze feedback\n3. Create report', { userId: 1 });
      assert.ok(result.subResults.length >= 2);
      assert.ok(result.answer.length > 0);
      assert.strictEqual(result.metadata.succeeded, result.subResults.length);
    });

    it('retries on transient errors with fast backoff', async () => {
      let attempts = 0;
      const orch = new SubAgentOrchestrator({
        maxRetries: 3,
        retryDelayMs: 1,
        runSubAgent: async () => {
          attempts++;
          if (attempts < 2) throw new Error('Rate limit exceeded');
          return { answer: 'Success after retry', steps: [], stoppedReason: 'completed' };
        },
      });
      const result = await orch.orchestrate('Retry test', { userId: 1 });
      assert.ok(attempts >= 2);
      assert.ok(result.answer.includes('Success'));
    });

    it('fails on permanent errors after all retries', async () => {
      const orch = new SubAgentOrchestrator({
        maxRetries: 1,
        retryDelayMs: 1,
        runSubAgent: async () => { throw new Error('Permanent failure'); },
      });
      const result = await orch.orchestrate('Fail test', { userId: 1 });
      assert.ok(result.stoppedReason.startsWith('all_sub_agents_failed'));
    });

    it('respects cancellation signal', async () => {
      const aborter = new AbortController();
      const orch = new SubAgentOrchestrator({
        runSubAgent: async () => {
          await new Promise(r => setTimeout(r, 500));
          return { answer: 'too late', steps: [], stoppedReason: 'completed' };
        },
      });
      setTimeout(() => aborter.abort(), 10);
      const result = await orch.orchestrate('Cancel test', { userId: 1 }, { signal: aborter.signal });
      // Either cancelled or the sub-agent already finished with an error
      assert.ok(result.stoppedReason === 'cancelled' || result.stoppedReason.startsWith('all_sub_agents_failed'));
    });

    it('handles partial success when some sub-agents fail', async () => {
      let callIdx = 0;
      const orch = new SubAgentOrchestrator({
        maxRetries: 1,
        retryDelayMs: 1,
        runSubAgent: async (goal) => {
          callIdx++;
          if (callIdx === 2) throw new Error('Sub-agent 2 failed');
          return { answer: `Result: ${goal}`, steps: [], stoppedReason: 'completed' };
        },
      });
      const result = await orch.orchestrate('1. Research topic\n2. Impossible task\n3. Write output', { userId: 1 });
      assert.ok(result.subResults.length >= 1);
      assert.ok(result.stoppedReason.includes('partial'));
    });

    it('times out slow sub-agents', async () => {
      const orch = new SubAgentOrchestrator({
        subTaskTimeoutMs: 50,
        maxRetries: 0,
        runSubAgent: async () => {
          await new Promise(r => setTimeout(r, 500));
          return { answer: 'too slow', steps: [], stoppedReason: 'completed' };
        },
      });
      const result = await orch.orchestrate('Timeout test', { userId: 1 });
      assert.ok(result.stoppedReason.startsWith('all_sub_agents_failed'));
    });

    it('synthesises multiple results into coherent answer', async () => {
      const orch = new SubAgentOrchestrator({
        runSubAgent: async (goal) => ({
          answer: `Detailed analysis: ${goal}`,
          steps: [], stoppedReason: 'completed',
        }),
      });
      const result = await orch.orchestrate('1. Analyze market\n2. Evaluate competitors', { userId: 1 });
      assert.ok(result.answer.includes('Detailed analysis'));
    });
  });
});

describe('createOrchestrator', () => {
  it('wraps an existing agent runner', async () => {
    const callLog = [];
    const agentRunner = async (goal, ctx, opts) => {
      callLog.push({ goal, maxSteps: opts?.maxSteps });
      return { answer: `Agent result: ${goal}`, steps: [], stoppedReason: 'completed' };
    };
    const orch = createOrchestrator(agentRunner, { maxStepsPerSub: 4 });
    assert.ok(orch instanceof SubAgentOrchestrator);
    const result = await orch.orchestrate('Test agent runner', { userId: 1 });
    assert.strictEqual(callLog.length, 1);
    assert.strictEqual(callLog[0].maxSteps, 4);
    assert.ok(result.answer.includes('Agent result'));
  });
});

describe('SubAgentError', () => {
  it('creates structured error with subTaskId', () => {
    const err = new SubAgentError('task-123', 'something broke', new Error('cause'));
    assert.strictEqual(err.subTaskId, 'task-123');
    assert.ok(err.message.includes('task-123'));
  });
});

describe('SubAgentOrchestrator — signal listener cleanup', () => {
  const { getEventListeners } = require('node:events');

  it('detaches the abort listener after _runWithTimeout resolves without abort', async () => {
    const orch = new SubAgentOrchestrator({ subTaskTimeoutMs: 1000 });
    orch._runSubAgent = async () => ({ ok: true });
    const ac = new AbortController();
    const res = await orch._runWithTimeout('goal', { userId: 1 }, ac.signal);
    assert.deepStrictEqual(res, { ok: true });
    assert.strictEqual(getEventListeners(ac.signal, 'abort').length, 0);
  });

  it('does not accumulate listeners across repeated runs on a reused signal', async () => {
    const orch = new SubAgentOrchestrator({ subTaskTimeoutMs: 1000 });
    orch._runSubAgent = async () => ({ ok: true });
    const ac = new AbortController();
    for (let i = 0; i < 5; i++) {
      await orch._runWithTimeout('goal', {}, ac.signal);
    }
    assert.strictEqual(getEventListeners(ac.signal, 'abort').length, 0);
  });
});
