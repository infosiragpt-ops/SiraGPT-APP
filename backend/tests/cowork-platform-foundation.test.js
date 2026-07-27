'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '1'.repeat(64);

const workspaceStore = require('../src/services/cowork/workspace-store');
const controlPlane = require('../src/services/cowork/control-plane');
const permissionManager = require('../src/services/agent-harness/permission-manager');
const connectorCatalog = require('../src/services/cowork/connector-catalog');
const scheduler = require('../src/services/cowork/scheduler');
const headlessRunner = require('../src/services/cowork/headless-runner');
const reactAgent = require('../src/services/react-agent');
const { buildCoworkTools } = require('../src/services/agent-harness/tools/cowork-tools');

describe('Cowork workspace contracts', () => {
  test('normalizes relative paths and rejects traversal or absolute paths', () => {
    assert.equal(workspaceStore.normalizeWorkspacePath('reports/weekly.md'), 'reports/weekly.md');
    assert.equal(workspaceStore.normalizeWorkspacePath('reports\\weekly.md'), 'reports/weekly.md');
    for (const unsafe of ['../secret', 'reports/../secret', '/etc/passwd', 'a\0b']) {
      assert.throws(
        () => workspaceStore.normalizeWorkspacePath(unsafe),
        (error) => error?.code === 'workspace_path_invalid',
      );
    }
  });

  test('default glob includes both root and nested files', async () => {
    const files = [
      { id: 'f1', path: 'README.md', mime: 'text/markdown', currentVersion: 1 },
      { id: 'f2', path: 'reports/weekly.md', mime: 'text/markdown', currentVersion: 1 },
    ];
    const prisma = {
      coworkWorkspace: {
        findFirst: async () => ({ id: 'w1', userId: 'u1' }),
      },
      coworkFile: {
        findMany: async () => files,
      },
    };
    const result = await workspaceStore.globFiles(prisma, {
      workspaceId: 'w1',
      userId: 'u1',
      pattern: '**/*',
    });
    assert.deepEqual(result.map((file) => file.path), ['README.md', 'reports/weekly.md']);
  });

  test('line diff preserves unchanged context and marks changes', () => {
    const diff = workspaceStore.lineDiff('one\ntwo\nthree', 'one\nsecond\nthree');
    assert.match(diff, /^ one/m);
    assert.match(diff, /^-two/m);
    assert.match(diff, /^\+second/m);
  });

  test('rejects malformed base64 before writing a binary workspace file', async () => {
    const prisma = {
      coworkWorkspace: {
        findFirst: async () => ({ id: 'w1', userId: 'u1' }),
      },
    };
    await assert.rejects(
      workspaceStore.writeFile(prisma, {
        workspaceId: 'w1',
        userId: 'u1',
        filePath: 'deliverables/report.docx',
        content: 'not-valid@@',
        encoding: 'base64',
      }),
      (error) => error?.code === 'workspace_content_invalid',
    );
  });
});

describe('Cowork control plane contracts', () => {
  test('checklist accepts one active item and rejects ambiguous progress', () => {
    const checklist = controlPlane.normalizeChecklist([
      { text: 'Inspect', status: 'completed' },
      { text: 'Implement', status: 'in_progress' },
      { text: 'Verify', status: 'pending' },
    ]);
    assert.equal(checklist.length, 3);
    assert.equal(checklist[1].status, 'in_progress');
    assert.throws(
      () => controlPlane.normalizeChecklist([
        { text: 'A', status: 'in_progress' },
        { text: 'B', status: 'in_progress' },
      ]),
      (error) => error?.code === 'checklist_multiple_active_items',
    );
  });

  test('plan limits are bounded and ordered by concurrency', () => {
    assert.equal(controlPlane.limitsForPlan('free').concurrency, 1);
    assert.ok(controlPlane.limitsForPlan('PRO').maxSteps > controlPlane.limitsForPlan('FREE').maxSteps);
    assert.ok(controlPlane.limitsForPlan('ENTERPRISE').maxCostUsd > controlPlane.limitsForPlan('PRO').maxCostUsd);
  });

  test('reserves a concurrency slot transactionally and retries serialization conflicts', async () => {
    let attempts = 0;
    let isolationLevel = null;
    const prisma = {
      user: {
        findUnique: async () => ({
          id: 'u1',
          plan: 'FREE',
          isAdmin: false,
          isSuperAdmin: false,
        }),
      },
      coworkRun: {
        count: async () => 0,
        create: async ({ data }) => ({ id: 'r-serial', ...data }),
      },
      agentAuditLog: {
        create: async () => ({}),
      },
      $transaction: async (callback, options) => {
        attempts += 1;
        isolationLevel = options?.isolationLevel;
        if (attempts === 1) {
          const error = new Error('serialization conflict');
          error.code = 'P2034';
          throw error;
        }
        return callback(prisma);
      },
    };
    const run = await controlPlane.createRun(prisma, {
      userId: 'u1',
      prompt: 'Create a report',
    });
    assert.equal(run.id, 'r-serial');
    assert.equal(attempts, 2);
    assert.equal(isolationLevel, 'Serializable');
  });

  test('finishing a run is idempotent and rolls cost up once', async () => {
    const run = {
      id: 'r1',
      userId: 'u1',
      workspaceId: 'w1',
      chatId: 'c1',
      status: 'running',
      kind: 'chat',
      currentStep: 1,
      costUsd: 0.12,
      tokensEstimate: 50,
      lastEvent: null,
    };
    let rollups = 0;
    const prisma = {
      coworkRun: {
        findFirst: async ({ where }) => (
          where.id === run.id && where.userId === run.userId ? { ...run } : null
        ),
        updateMany: async ({ where, data }) => {
          if (where.id !== run.id || !where.status.in.includes(run.status)) return { count: 0 };
          Object.assign(run, data);
          return { count: 1 };
        },
        findUnique: async () => ({ ...run }),
      },
      coworkCostDaily: {
        upsert: async () => {
          rollups += 1;
          return {};
        },
      },
      agentAuditLog: {
        create: async () => ({}),
      },
    };
    await controlPlane.finishRun(prisma, {
      runId: 'r1',
      userId: 'u1',
      status: 'completed',
      lastEvent: 'done',
      costUsd: 0.9,
      tokensEstimate: 999,
    });
    await controlPlane.finishRun(prisma, {
      runId: 'r1',
      userId: 'u1',
      status: 'completed',
      lastEvent: 'done again',
    });
    assert.equal(run.status, 'completed');
    assert.equal(run.costUsd, 0.12);
    assert.equal(run.tokensEstimate, 50);
    assert.equal(rollups, 1);
  });

  test('does not overwrite a terminal state won by a concurrent finisher', async () => {
    const run = {
      id: 'r-race',
      userId: 'u1',
      workspaceId: 'w1',
      chatId: 'c1',
      status: 'running',
      costUsd: 0,
      tokensEstimate: 0,
    };
    let auditWrites = 0;
    const prisma = {
      coworkRun: {
        findFirst: async () => ({ ...run }),
        updateMany: async () => {
          run.status = 'completed';
          run.finishedAt = new Date();
          return { count: 0 };
        },
      },
      agentAuditLog: {
        create: async () => {
          auditWrites += 1;
          return {};
        },
      },
    };
    const result = await controlPlane.transitionRun(prisma, {
      runId: run.id,
      userId: run.userId,
      action: 'cancel',
    });
    assert.equal(result.status, 'completed');
    assert.equal(auditWrites, 0);
  });

  test('observes a concurrent cancellation before starting the next step', async () => {
    const run = {
      id: 'r-cancel-race',
      userId: 'u1',
      workspaceId: 'w1',
      status: 'running',
      currentStep: 0,
      maxSteps: 12,
      costUsd: 0,
      maxCostUsd: 1,
    };
    const prisma = {
      coworkRun: {
        findFirst: async () => ({ ...run }),
        updateMany: async () => {
          run.status = 'cancelled';
          return { count: 0 };
        },
      },
    };
    const result = await controlPlane.beforeStep(prisma, {
      runId: run.id,
      userId: run.userId,
      step: 0,
    });
    assert.deepEqual(result, { stop: true, reason: 'cancelled_by_user' });
  });

  test('rolls up cost when the budget guard cancels a run', async () => {
    const run = {
      id: 'r-budget',
      userId: 'u1',
      workspaceId: 'w1',
      chatId: 'c1',
      status: 'running',
      currentStep: 2,
      maxSteps: 12,
      costUsd: 0.25,
      maxCostUsd: 0.25,
      tokensEstimate: 500,
    };
    let rollups = 0;
    const prisma = {
      coworkRun: {
        findFirst: async () => ({ ...run }),
        updateMany: async ({ data }) => {
          Object.assign(run, data);
          return { count: 1 };
        },
      },
      coworkCostDaily: {
        upsert: async () => {
          rollups += 1;
          return {};
        },
      },
      agentAuditLog: {
        create: async () => ({}),
      },
    };
    const result = await controlPlane.beforeStep(prisma, {
      runId: run.id,
      userId: run.userId,
      step: 2,
    });
    assert.deepEqual(result, { stop: true, reason: 'cost_budget_exhausted' });
    assert.equal(run.status, 'cancelled');
    assert.equal(rollups, 1);
  });

  test('persists active checkpoints and rejects oversized replay state', async () => {
    let saved = null;
    const prisma = {
      coworkRun: {
        findFirst: async () => ({
          id: 'r-checkpoint',
          userId: 'u1',
          status: 'running',
        }),
        updateMany: async ({ data }) => {
          saved = data;
          return { count: 1 };
        },
      },
    };
    const checkpoint = { step: 3, messages: [{ role: 'assistant', content: 'continue' }] };
    await controlPlane.saveCheckpoint(prisma, {
      runId: 'r-checkpoint',
      userId: 'u1',
      checkpoint,
    });
    assert.deepEqual(saved.checkpoint, checkpoint);
    assert.deepEqual(saved.controlVersion, { increment: 1 });

    await assert.rejects(
      controlPlane.saveCheckpoint(prisma, {
        runId: 'r-checkpoint',
        userId: 'u1',
        checkpoint: { payload: 'x'.repeat(2_000_001) },
      }),
      (error) => error?.code === 'cowork_checkpoint_too_large' && error?.status === 413,
    );
  });
});

describe('Cowork per-step usage and model fallback', () => {
  function finalResponse(model, usage) {
    return {
      usage,
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call-final',
            type: 'function',
            function: {
              name: 'finalize',
              arguments: JSON.stringify({ answer: `done by ${model}`, confidence: 'high' }),
            },
          }],
        },
      }],
    };
  }

  test('records provider token usage and cost on the completed step', async () => {
    const openai = {
      chat: {
        completions: {
          create: async ({ model }) => finalResponse(model, {
            prompt_tokens: 1000,
            completion_tokens: 500,
            total_tokens: 1500,
          }),
        },
      },
    };
    const result = await reactAgent.run(openai, {
      query: 'Finish this task',
      tools: [],
      model: 'gpt-4o',
      maxSteps: 1,
      ctx: { provider: 'OpenAI' },
    });
    assert.equal(result.steps[0].usage.tokensEstimate, 1500);
    assert.equal(result.steps[0].usage.costUsd, 0.0075);
    assert.equal(result.steps[0].usage.provider, 'OpenAI');
  });

  test('switches clients at a step boundary and treats Cerebras fallback as free', async () => {
    const primary = {
      chat: {
        completions: {
          create: async () => {
            throw new Error('primary client should not be used');
          },
        },
      },
    };
    const fallback = {
      chat: {
        completions: {
          create: async ({ model }) => finalResponse(model, {
            prompt_tokens: 900,
            completion_tokens: 100,
          }),
        },
      },
    };
    const result = await reactAgent.run(primary, {
      query: 'Finish with fallback',
      tools: [],
      model: 'gpt-4o',
      maxSteps: 1,
      ctx: { provider: 'OpenAI' },
      onBeforeStep: async () => ({
        clientOverride: fallback,
        modelOverride: 'gpt-oss-120b',
        providerOverride: 'Cerebras',
      }),
    });
    assert.equal(result.finalAnswer, 'done by gpt-oss-120b');
    assert.equal(result.steps[0].usage.tokensEstimate, 1000);
    assert.equal(result.steps[0].usage.costUsd, 0);
    assert.equal(result.steps[0].usage.source, 'provider-free-tier');
  });
});

describe('Cowork tools and scheduling', () => {
  test('registers workspace, steering, parallel, scheduler, and visible-browser tools', () => {
    const tools = buildCoworkTools();
    const names = new Set(tools.map((tool) => tool.name));
    for (const name of [
      'ws_read',
      'ws_write',
      'ws_edit',
      'ws_glob',
      'ws_grep',
      'update_checklist',
      'workspace_memory',
      'spawn_task',
      'schedule_task',
      'browse_page',
    ]) {
      assert.ok(names.has(name), `missing tool ${name}`);
    }
    assert.equal(tools.find((tool) => tool.name === 'ws_delete').permissionTier, 'confirm');
    assert.equal(tools.find((tool) => tool.name === 'schedule_task').permissionTier, 'confirm');
  });

  test('workspace memory recall is scoped to the authenticated workspace', async () => {
    let where = null;
    const prisma = {
      coworkMemory: {
        findMany: async (query) => {
          where = query.where;
          return [
            { id: 'm1', fact: 'Use the quarterly finance template', createdAt: new Date() },
            { id: 'm2', fact: 'Unrelated product note', createdAt: new Date() },
          ];
        },
      },
    };
    const tool = buildCoworkTools().find((candidate) => candidate.name === 'workspace_memory');
    const result = await tool.execute(
      { action: 'recall', query: 'finance template', limit: 10 },
      { prisma, userId: 'u1', workspaceId: 'w1', coworkRunId: 'r1' },
    );
    assert.deepEqual(where, { userId: 'u1', workspaceId: 'w1' });
    assert.equal(result.facts.length, 1);
    assert.equal(result.facts[0].id, 'm1');
  });

  test('computes cron schedules in the user timezone', () => {
    const result = scheduler.nextRun(
      '0 9 * * 1',
      'America/Lima',
      new Date('2026-07-26T12:00:00.000Z'),
    );
    assert.equal(result.toISOString(), '2026-07-27T14:00:00.000Z');
    assert.throws(() => scheduler.nextRun('invalid', 'America/Lima'));
    assert.throws(() => scheduler.nextRun('0 9 * * 1', 'Invalid/Timezone'));
    assert.equal(scheduler.LOCK_MS, 25 * 60_000);
  });

  test('headless runtime preserves an explicitly injected provider client', () => {
    const client = { chat: { completions: { create: async () => ({}) } } };
    const runtime = headlessRunner.resolveHeadlessRuntime({
      client,
      model: 'test-model',
      provider: 'TestProvider',
    });
    assert.equal(runtime.client, client);
    assert.equal(runtime.model, 'test-model');
    assert.equal(runtime.provider, 'TestProvider');
  });

  test('headless runtime preserves supported subtask thinking levels', () => {
    assert.equal(headlessRunner.normalizeThinking('high'), 'high');
    assert.equal(headlessRunner.normalizeThinking('medium'), 'medium');
    assert.equal(headlessRunner.normalizeThinking('unsupported'), 'low');
  });

  test('scheduler updates clamp budgets to the current plan', async () => {
    const existing = {
      id: 'scheduled-1',
      userId: 'u1',
      prompt: 'Original task',
      cronExpr: '0 9 * * 1',
      tz: 'America/Lima',
      deliver: 'chat',
      maxSteps: 8,
      maxCostUsd: 0.1,
    };
    let written = null;
    const prisma = {
      scheduledAgentTask: {
        findFirst: async () => ({ ...existing }),
        update: async ({ data }) => {
          written = data;
          return { ...existing, ...data };
        },
      },
      user: {
        findUnique: async () => ({
          id: 'u1',
          plan: 'FREE',
          isAdmin: false,
          isSuperAdmin: false,
        }),
      },
    };
    const updated = await scheduler.updateScheduledTask(prisma, {
      userId: 'u1',
      taskId: existing.id,
      patch: {
        prompt: '  Updated task  ',
        maxSteps: 999,
        maxCostUsd: 999,
      },
    });
    assert.equal(updated.prompt, 'Updated task');
    assert.equal(written.maxSteps, controlPlane.PLAN_LIMITS.FREE.maxSteps);
    assert.equal(written.maxCostUsd, controlPlane.PLAN_LIMITS.FREE.maxCostUsd);
    await assert.rejects(
      scheduler.updateScheduledTask(prisma, {
        userId: 'u1',
        taskId: existing.id,
        patch: { prompt: '   ' },
      }),
      (error) => error?.code === 'scheduled_prompt_required',
    );
  });
});

describe('Cowork approvals and connector catalog', () => {
  beforeEach(() => {
    permissionManager.resetForTests();
    permissionManager.setPermissionAuditor(null);
  });

  test('live approvals preserve the synchronous resolver contract and advertise a 24h TTL', async () => {
    let request;
    const pending = permissionManager.requestPermission({
      chatId: 'c1',
      userId: 'u1',
      toolName: 'ws_delete',
      humanDescription: 'Delete report',
      onRequest: (payload) => { request = payload; },
    });
    assert.ok(request.expiresInMs >= 23 * 60 * 60 * 1000);
    const result = permissionManager.resolvePermission({
      permissionId: request.permissionId,
      decision: 'allow',
      userId: 'u1',
    });
    assert.equal(result.ok, true);
    assert.equal((await pending).decision, 'allow');
  });

  test('durable approvals survive a missing in-memory resolver and resume from paused state', async () => {
    const approval = {
      id: 'approval-1',
      userId: 'u1',
      runId: 'run-1',
      tool: 'schedule_task',
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000),
    };
    let runStatus = 'waiting_approval';
    const prisma = {
      agentApproval: {
        findFirst: async () => ({ ...approval, run: { id: 'run-1' } }),
        updateMany: async ({ data }) => {
          if (approval.status !== 'pending') return { count: 0 };
          Object.assign(approval, data);
          return { count: 1 };
        },
      },
      coworkRun: {
        updateMany: async ({ data }) => {
          runStatus = data.status;
          return { count: 1 };
        },
      },
      $transaction: async (callback) => callback(prisma),
    };
    const result = await permissionManager.resolvePermission({
      permissionId: approval.id,
      decision: 'allow',
      userId: 'u1',
      prisma,
    });
    assert.equal(result.ok, true);
    assert.equal(result.durable, true);
    assert.equal(result.requiresResume, true);
    assert.equal(approval.status, 'approved');
    assert.equal(runStatus, 'paused');
    const repeated = await permissionManager.resolvePermission({
      permissionId: approval.id,
      decision: 'allow',
      userId: 'u1',
      prisma,
    });
    assert.equal(repeated.ok, false);
    assert.equal(repeated.status, 409);
  });

  test('durable approvals outlive a browser abort and explicit run cancellation settles them', async () => {
    const created = [];
    const prisma = {
      agentApproval: {
        create: async ({ data }) => {
          created.push(data);
          return data;
        },
        updateMany: async () => ({ count: 1 }),
      },
      coworkRun: {
        updateMany: async () => ({ count: 1 }),
      },
      $transaction: async (callback) => callback(prisma),
    };
    const controller = new AbortController();
    let settled = false;
    const pending = permissionManager.requestPermission({
      chatId: 'c1',
      userId: 'u1',
      runId: 'run-durable',
      workspaceId: 'w1',
      toolName: 'schedule_task',
      humanDescription: 'Create a recurring task',
      signal: controller.signal,
      prisma,
      onRequest: () => {},
    }).then((value) => {
      settled = true;
      return value;
    });
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(settled, false);
    assert.equal(created.length, 1);
    assert.equal(permissionManager.cancelRun('run-durable'), 1);
    const outcome = await pending;
    assert.equal(outcome.decision, 'deny');
    assert.equal(outcome.reason, 'run_cancelled');
  });

  test('checkpoint resume consumes one matching durable approval grant', async () => {
    let status = 'approved';
    const args = '{"cronExpr":"0 9 * * 1"}';
    const prisma = {
      agentApproval: {
        findFirst: async () => ({
          id: 'approval-grant',
          userId: 'u1',
          runId: 'run-resume',
          tool: 'schedule_task',
          status,
          args,
          resolvedAt: new Date(),
        }),
        updateMany: async ({ where, data }) => {
          if (where.id !== 'approval-grant' || where.status !== status) return { count: 0 };
          status = data.status;
          return { count: 1 };
        },
      },
    };
    const result = await permissionManager.requestPermission({
      userId: 'u1',
      runId: 'run-resume',
      toolName: 'schedule_task',
      args,
      prisma,
      onRequest: () => {
        throw new Error('a matching durable grant must not create a second approval card');
      },
    });
    assert.equal(result.decision, 'allow');
    assert.equal(result.durableGrant, true);
    assert.equal(status, 'consumed');
  });

  test('legacy Google tokens appear as connected catalog accounts without exposing secrets', async () => {
    const prisma = {
      connectorAccount: {
        findMany: async () => [],
      },
      user: {
        findUnique: async () => ({
          gmailTokens: 'sealed-gmail',
          googleServicesTokens: 'sealed-services',
        }),
      },
    };
    const connectors = await connectorCatalog.listConnectors(prisma, 'u1');
    assert.equal(connectors.find((item) => item.id === 'gmail').account.status, 'connected');
    assert.equal(connectors.find((item) => item.id === 'google_drive').account.status, 'connected');
    assert.equal(JSON.stringify(connectors).includes('sealed-gmail'), false);
  });

  test('connector tokens and configuration are encrypted and never returned', async () => {
    let persisted = null;
    const prisma = {
      connectorAccount: {
        upsert: async ({ create }) => {
          persisted = create;
          return { id: 'connector-1', ...create, lastHealthAt: new Date() };
        },
      },
      agentAuditLog: {
        create: async () => ({}),
      },
    };
    const account = await connectorCatalog.upsertConnector(prisma, {
      userId: 'u1',
      provider: 'slack',
      accountLabel: 'Operations',
      token: { accessToken: 'sensitive-token' },
      config: { webhookUrl: 'https://hooks.example.invalid/secret' },
    });
    assert.equal(typeof persisted.tokenEncrypted, 'string');
    assert.equal(typeof persisted.configEncrypted, 'string');
    assert.equal(JSON.stringify(persisted).includes('sensitive-token'), false);
    assert.equal(JSON.stringify(persisted).includes('/secret'), false);
    assert.equal(Object.hasOwn(account, 'tokenEncrypted'), false);
    assert.equal(Object.hasOwn(account, 'configEncrypted'), false);
  });
});
