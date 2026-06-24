const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const {
  buildRouteTestApp,
  installAuthSessionMock,
  mockResolvedModule,
  reloadModule,
} = require('./http-test-utils');

function rememberEnv(keys) {
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function parseSseEvents(text) {
  return String(text || '')
    .split(/\n\n+/)
    .map((chunk) => chunk.split(/\n/).find((line) => line.startsWith('data: ')))
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line.slice(6)); } catch { return null; }
    })
    .filter(Boolean);
}

function installOpenAIMock() {
  const moduleId = require.resolve('openai');
  const previous = require.cache[moduleId];

  class FakeOpenAI {
    constructor() {
      let agentCallCount = 0;
      this.chat = {
        completions: {
          create: async (payload = {}) => {
            if (payload.response_format?.type === 'json_schema') {
              return { choices: [{ message: { content: '{"not":"a task contract"}' } }] };
            }

            agentCallCount += 1;
            if (agentCallCount === 1) {
              return {
                choices: [{
                  message: {
                    content: 'Verifico el cambio cognitivo con una prueba determinística.',
                    tool_calls: [{
                      id: 'call_run_tests_brain',
                      type: 'function',
                      function: {
                        name: 'run_tests',
                        arguments: JSON.stringify({
                          language: 'javascript',
                          source: 'module.exports = { activeControls: () => 100 };',
                          testSource: "const solution = require('./solution'); _check('100 cognitive controls available', solution.activeControls() === 100, 'expected 100 controls');",
                          timeoutMs: 5000,
                        }),
                      },
                    }],
                  },
                }],
              };
            }

            return {
              choices: [{
                message: {
                  content: 'Finalizo con evidencia del control plane cognitivo.',
                  tool_calls: [{
                    id: 'call_finalize_brain',
                    type: 'function',
                    function: {
                      name: 'finalize',
                      arguments: JSON.stringify({
                        answer: 'Control plane cognitivo verificado con catálogo de 100 controles y gate run_tests ejecutado.',
                        confidence: 0.91,
                      }),
                    },
                  }],
                },
              }],
            };
          },
        },
      };
    }
  }

  require.cache[moduleId] = {
    id: moduleId,
    filename: moduleId,
    loaded: true,
    exports: FakeOpenAI,
  };

  return () => {
    if (previous) require.cache[moduleId] = previous;
    else delete require.cache[moduleId];
  };
}

function installAgentTaskPersistenceMock() {
  const resolvedPath = require.resolve('../src/services/agents/agent-task-persistence');
  const noop = async () => null;
  return mockResolvedModule(resolvedPath, {
    appendAgentTaskEvent: noop,
    archiveCompletedAgentTasks: async () => ({ archived: 0, scanned: 0 }),
    purgeOrphanedArtifacts: async () => ({ purged: 0, candidates: [] }),
    persistGeneratedArtifact: noop,
    recoverOrphanedAgentTasks: async () => ({ recovered: 0, scanned: 0 }),
    upsertAgentTask: noop,
  });
}

function clearAgentTaskModules() {
  for (const modulePath of [
    '../src/routes/agent-task',
    '../src/services/agents/agent-task-runner',
    '../src/services/agents/task-contract-resolver',
    '../src/services/agents/agent-task-persistence',
  ]) {
    try { delete require.cache[require.resolve(modulePath)]; } catch (_) { /* ignore */ }
  }
}

describe('E2E agent brain cognitive control plane', () => {
  let auth;
  let restoreEnv;
  let restoreOpenAI;
  let restorePersistence;
  let taskStoreDir;

  beforeEach(() => {
    auth = installAuthSessionMock();
    restoreOpenAI = installOpenAIMock();
    restoreEnv = rememberEnv(['OPENAI_API_KEY', 'REDIS_URL', 'AGENT_TASK_INLINE', 'AGENT_TASK_STORE_DIR']);
    taskStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-agent-brain-e2e-'));
    process.env.OPENAI_API_KEY = 'test';
    delete process.env.REDIS_URL;
    delete process.env.AGENT_TASK_INLINE;
    process.env.AGENT_TASK_STORE_DIR = taskStoreDir;
    clearAgentTaskModules();
    restorePersistence = installAgentTaskPersistenceMock();
  });

  afterEach(() => {
    if (restorePersistence) restorePersistence();
    clearAgentTaskModules();
    if (restoreOpenAI) restoreOpenAI();
    fs.rmSync(taskStoreDir, { recursive: true, force: true });
    restoreEnv();
    auth.restore();
  });

  test('POST /api/agent/task emits the 100-control cognitive brain upgrade metadata before fallback completion', async () => {
    const app = buildRouteTestApp('/api/agent', reloadModule('../src/routes/agent-task'));
    const res = await request(app)
      .post('/api/agent/task')
      .set('Authorization', auth.authHeader)
      .send({
        goal: 'Implementa 100 mejoras en el backend, mejora el cerebro del software y aplica pruebas e2e',
        scopeMode: 'global',
        maxSteps: 4,
        maxRuntimeMs: 60000,
      });

    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);

    const events = parseSseEvents(res.text);
    const meta = events.find((event) => event.type === 'meta');
    const done = events.find((event) => event.type === 'done');

    assert.ok(meta, 'expected meta SSE event');
    assert.equal(meta.agenticOperatingCore.cognitive_improvements.summary.totalControlCount, 100);
    assert.equal(meta.agenticOperatingCore.cognitive_improvements.summary.activeControlCount, 100);
    assert.equal(meta.enterpriseRuntimeProfile.agenticOperatingCore.cognitiveImprovementCount, 100);
    assert.ok(meta.agenticOperatingCore.validation.deterministic_checks.includes('cognitive.e2e-user-journey-probe'));
    assert.ok(done, 'expected done SSE event');
  });

  test('POST /api/agent/task exposes the universal 1000-agent fabric for broad autonomous requests', async () => {
    const app = buildRouteTestApp('/api/agent', reloadModule('../src/routes/agent-task'));
    const res = await request(app)
      .post('/api/agent/task')
      .set('Authorization', auth.authHeader)
      .send({
        goal: 'Ciclo agentico para todo con 1000 agentes para entender contexto, programar, validar y no terminar hasta lograrlo',
        scopeMode: 'global',
        maxSteps: 4,
        maxRuntimeMs: 60000,
      });

    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);

    const events = parseSseEvents(res.text);
    const meta = events.find((event) => event.type === 'meta');
    const done = events.find((event) => event.type === 'done');

    assert.ok(meta, 'expected meta SSE event');
    assert.equal(meta.executionProfile.universalAgents.summary.totalAgentCount, 1000);
    assert.equal(meta.executionProfile.universalAgents.summary.universalAgentRequest, true);
    assert.equal(meta.agenticOperatingCore.universal_agents.summary.totalAgentCount, 1000);
    assert.equal(meta.agenticOperatingCore.universal_agents.summary.allCyclePhasesCovered, true);
    assert.equal(meta.enterpriseRuntimeProfile.agenticOperatingCore.universalAgentCatalogCount, 1000);
    assert.ok(meta.agenticOperatingCore.validation.deterministic_checks.includes('universal_agents.catalog_1000'));
    assert.ok(done, 'expected done SSE event');
  });
});
