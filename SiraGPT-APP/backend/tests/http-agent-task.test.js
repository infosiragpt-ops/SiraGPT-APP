const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const request = require('supertest');

const {
  buildRouteTestApp,
  createContractValidator,
  installAuthSessionMock,
  reloadModule,
} = require('./http-test-utils');

const assertContractResponse = createContractValidator();

function rememberEnv(keys) {
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

describe('HTTP agent task route', () => {
  let auth;
  let restoreEnv;
  let taskStoreDir;

  beforeEach(() => {
    auth = installAuthSessionMock();
    restoreEnv = rememberEnv(['OPENAI_API_KEY', 'REDIS_URL', 'AGENT_TASK_INLINE', 'AGENT_TASK_STORE_DIR']);
    taskStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-agent-task-http-'));
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
    delete process.env.REDIS_URL;
    delete process.env.AGENT_TASK_INLINE;
    process.env.AGENT_TASK_STORE_DIR = taskStoreDir;
    delete require.cache[require.resolve('../src/routes/agent-task')];
  });

  afterEach(() => {
    delete require.cache[require.resolve('../src/routes/agent-task')];
    fs.rmSync(taskStoreDir, { recursive: true, force: true });
    restoreEnv();
    auth.restore();
  });

  function buildApp() {
    return buildRouteTestApp('/api/agent', reloadModule('../src/routes/agent-task'));
  }

  function installAnalyzedDocumentMock() {
    const prisma = require('../src/config/database');
    const persistence = require('../src/services/agents/agent-task-persistence');
    const originalFileFindMany = prisma.file.findMany;
    const originalUpsert = persistence.upsertAgentTask;
    const originalAppend = persistence.appendAgentTaskEvent;
    const originalArtifact = persistence.persistGeneratedArtifact;

    prisma.file.findMany = async () => [{
      id: 'file-http-doc-1',
      filename: 'informe.pdf',
      originalName: 'informe.pdf',
      mimeType: 'application/pdf',
      size: 2048,
      path: '/tmp/informe.pdf',
      extractedText: [
        'El informe describe un programa de vacunacion comunitaria con cobertura creciente durante tres trimestres consecutivos.',
        'Los resultados muestran reduccion de hospitalizaciones y mejor adherencia cuando se combinan brigadas moviles con recordatorios por SMS.',
        'La principal limitacion reportada es la falta de personal en zonas rurales y la necesidad de reforzar la cadena de frio.',
      ].join(' '),
      openaiFileId: null,
      documentAnalysis: {
        id: 'analysis-http-doc-1',
        status: 'completed',
        summary: 'Programa de vacunacion comunitaria',
        textCoverage: { status: 'ok' },
        ocr: null,
        warnings: [],
        pageCount: 3,
        sheetCount: null,
        slideCount: null,
        chunkCount: 1,
        tableCount: 0,
        chunks: [],
        tables: [],
      },
    }];
    persistence.upsertAgentTask = async () => null;
    persistence.appendAgentTaskEvent = async () => null;
    persistence.persistGeneratedArtifact = async () => null;

    return () => {
      prisma.file.findMany = originalFileFindMany;
      persistence.upsertAgentTask = originalUpsert;
      persistence.appendAgentTaskEvent = originalAppend;
      persistence.persistGeneratedArtifact = originalArtifact;
    };
  }

  test('requires auth before creating an agent task', async () => {
    const res = await request(buildApp())
      .post('/api/agent/task')
      .send({ goal: 'Write a short report' });

    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Access token required');
  });

  test('validates task creation body at the HTTP boundary', async () => {
    const res = await request(buildApp())
      .post('/api/agent/task')
      .set('Authorization', auth.authHeader)
      .send({ goal: 'no', maxRuntimeMs: 10 });

    assert.equal(res.status, 400);
    assert.ok(Array.isArray(res.body.errors));
    assertContractResponse('agent.task.create', 400, res.body);
  });

  test('streams the local fallback when Redis queueing is unavailable', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.REDIS_URL;

    const restoreDocumentMock = installAnalyzedDocumentMock();
    try {
      const res = await request(buildApp())
        .post('/api/agent/task')
        .set('Authorization', auth.authHeader)
        .send({
          goal: 'Resume este documento',
          scopeMode: 'global',
          files: ['file-http-doc-1'],
          fileMetadata: [{ id: 'file-http-doc-1', name: 'informe.pdf', mimeType: 'application/pdf' }],
          maxSteps: 3,
          maxRuntimeMs: 60000,
        });

      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], /text\/event-stream/);
      assert.match(res.text, /queue_status/);
      assert.match(res.text, /final_text/);
      assert.match(res.text, /done/);
    } finally {
      restoreDocumentMock();
    }
  });

  test('streams a document-grounded fallback when Redis and OpenAI are unavailable but a file is attached', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.REDIS_URL;

    const restoreDocumentMock = installAnalyzedDocumentMock();

    try {
      const res = await request(buildApp())
        .post('/api/agent/task')
        .set('Authorization', auth.authHeader)
        .send({
          goal: 'Qué dice este documento?',
          scopeMode: 'global',
          files: ['file-http-doc-1'],
          fileMetadata: [{ id: 'file-http-doc-1', name: 'informe.pdf', mimeType: 'application/pdf' }],
          maxSteps: 3,
          maxRuntimeMs: 60000,
        });

      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], /text\/event-stream/);
      assert.match(res.text, /final_text/);
      assert.match(res.text, /Análisis del documento adjunto/);
      assert.match(res.text, /programa de vacunacion comunitaria/);
      assert.match(res.text, /done/);
    } finally {
      restoreDocumentMock();
    }
  });

  test('reads durable task status for the authenticated owner', async () => {
    const taskStore = require('../src/services/agents/task-store');
    taskStore.writeTaskSnapshot({
      taskId: 'task-http-1',
      userId: auth.user.id,
      displayGoal: 'Inspect status',
      agentGoal: 'Inspect status',
      status: 'queued',
      queueName: 'agent-tasks',
      traceId: 'trace-http-1',
      streamState: { steps: [], artifacts: [], finalText: '', done: false },
      events: [{ type: 'queue_status', status: 'queued', seq: 1 }],
      lastEventSeq: 1,
    });

    const res = await request(buildApp())
      .get('/api/agent/task/task-http-1')
      .set('Authorization', auth.authHeader);

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.taskId, 'task-http-1');
    assert.equal(res.body.status, 'queued');
    assertContractResponse('agent.task.status', 200, res.body);
  });
});

describe('HTTP admin queue route', () => {
  let restoreEnv;
  let adminAuth;
  let userAuth;

  beforeEach(() => {
    restoreEnv = rememberEnv(['REDIS_URL']);
    delete process.env.REDIS_URL;
    adminAuth = installAuthSessionMock({ id: 'admin-http-1', email: 'admin-http@example.com', isAdmin: true });
    userAuth = installAuthSessionMock({ id: 'user-http-2', email: 'user-http-2@example.com', isAdmin: false });
    delete require.cache[require.resolve('../src/routes/admin-queues')];
  });

  afterEach(() => {
    delete require.cache[require.resolve('../src/routes/admin-queues')];
    userAuth.restore();
    adminAuth.restore();
    restoreEnv();
  });

  function buildApp() {
    return buildRouteTestApp('/api/admin/queues', reloadModule('../src/routes/admin-queues'));
  }

  test('requires admin privileges for queue status', async () => {
    const res = await request(buildApp())
      .get('/api/admin/queues/status')
      .set('Authorization', userAuth.authHeader);

    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'Admin access required');
    assertContractResponse('admin.queues.status', 403, res.body);
  });

  test('reports disabled queue board cleanly without Redis', async () => {
    const res = await request(buildApp())
      .get('/api/admin/queues/status')
      .set('Authorization', adminAuth.authHeader);

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.queueBoard.status, 'disabled');
    assert.equal(res.body.queueBoard.redisUrlConfigured, false);
    assert.equal(res.body.queueBoard.counts, null);
    assert.deepEqual(res.body.queueBoard.queueCounts, {
      total: 5,
      ready: 0,
      degraded: 0,
      unhealthy: 0,
      skipped: 5,
      criticalFailures: 0,
    });
    assert.equal(res.body.queueBoard.queues, undefined);
    assert.equal(res.body.queueBoard.reason, undefined);
    assert.doesNotMatch(JSON.stringify(res.body), /lastError/);
    assertContractResponse('admin.queues.status', 200, res.body);
  });
});

describe('HTTP health route contract', () => {
  test('returns the liveness contract without touching external dependencies', async () => {
    const {
      reportToHttpStatus,
      runLivenessCheck,
    } = require('../src/services/observability/health-check');
    const app = express();
    app.get('/health/live', (_req, res) => {
      const report = runLivenessCheck();
      res.status(reportToHttpStatus(report)).json(report);
    });

    const res = await request(app).get('/health/live');

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'healthy');
    assertContractResponse('health.live', 200, res.body);
  });
});
