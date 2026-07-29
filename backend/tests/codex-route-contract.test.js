'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { once } = require('node:events');
const express = require('express');
const request = require('supertest');
const WebSocket = require('ws');

const { mockResolvedModule } = require('./http-test-utils');

// Stub auth BEFORE the codex router loads it.
const authPath = require.resolve('../src/middleware/auth');
let authUser = { id: 'u-1', isAdmin: true, isSuperAdmin: false };
const restoreAuth = mockResolvedModule(authPath, {
  authenticateToken(req, _res, next) {
    req.user = authUser;
    next();
  },
});

// Stub project-service + runner-client BEFORE the router loads them.
const serviceCalls = [];
const servicePath = require.resolve('../src/services/codex/project-service');
const restoreService = mockResolvedModule(servicePath, {
  createProject: async (args) => {
    serviceCalls.push(['createProject', args]);
    return { id: 'p1', name: args.name, status: 'ready', workspacePath: 'projects/p1', previewUrl: 'http://localhost:5173', error: null };
  },
  listProjects: async (args) => {
    serviceCalls.push(['listProjects', args]);
    return [{ id: 'p1', name: 'A', status: 'ready' }];
  },
  getProject: async (args) => {
    serviceCalls.push(['getProject', args]);
    return args.id === 'p1' ? { id: 'p1', name: 'A', status: 'ready' } : null;
  },
});

const runnerCalls = [];
const runnerPath = require.resolve('../src/services/codex/runner-client');
const restoreRunner = mockResolvedModule(runnerPath, {
  createRunnerClient: () => ({
    // Multi-project runner: /run reports the project's assigned pool port and
    // the proxy targets it, so the mock port must be settable per test.
    startDev: async (project, opts) => { runnerCalls.push(['startDev', project, opts]); return { ok: true, port: runnerMockPort, project }; },
    devStatus: async () => {
      runnerStatusCalls++;
      if (runnerStatusQueue && runnerStatusQueue.length > 0) return runnerStatusQueue.shift();
      return { running: true, ready: true, project: 'p1', port: runnerMockPort };
    },
    stopDev: async () => ({ ok: true }),
    exportWorkspace: async (project) => { runnerCalls.push(['exportWorkspace', project]); return { ok: true, project, files: 5 }; },
    exec: async (project, cmd) => { runnerCalls.push(['exec', project, cmd]); return { ok: true, exitCode: 0, stdout: 'src/main.tsx\nindex.html\npackage.json\n', stderr: '' }; },
    readFile: async (project, path) => { runnerCalls.push(['readFile', project, path]); return { ok: true, path, content: '<html></html>' }; },
  }),
  runnerDevUrl: () => 'http://localhost:5173',
  codexExportHostPath: (id) => `.codex-workspaces/${id}`,
  RunnerError: class RunnerError extends Error {},
});

const publicationCalls = [];
const restorePublication = mockResolvedModule(
  require.resolve('../src/services/codex/publication-service'),
  {
    getPublication: async (args) => {
      publicationCalls.push(['get', args]);
      return {
        hostname: 'demo.apps.example.com',
        url: 'https://demo.apps.example.com',
        currentReleaseId: 'abc1234',
        publishedAt: '2026-07-26T12:00:00.000Z',
        releases: [],
      };
    },
    publishProject: async (args) => {
      publicationCalls.push(['publish', args]);
      return {
        ok: true,
        publication: { currentReleaseId: 'def5678', releases: [] },
        release: { id: 'def5678' },
        buildLog: 'built',
      };
    },
    rollbackPublication: async (args) => {
      publicationCalls.push(['rollback-publication', args]);
      return {
        ok: true,
        publication: { currentReleaseId: args.releaseId, releases: [] },
        release: { id: args.releaseId },
      };
    },
  },
);

const codexRoutes = require('../src/routes/codex');
const codexDb = require('../src/config/database');
const companyAssociationService = require('../src/services/codex/company-association-service');

let runnerStatusQueue = null;
let runnerStatusCalls = 0;
let runnerMockPort = 5173;

after(() => {
  restoreAuth();
  restoreService();
  restoreRunner();
  restorePublication();
  delete process.env.CODEX_AGENT_V2;
  delete process.env.CODEX_AGENT_ALLOWED_USER_IDS;
  delete process.env.CODEX_PREVIEW_START_POLL_MS;
  delete process.env.CODEX_PREVIEW_START_TIMEOUT_MS;
  delete process.env.CODEX_PREVIEW_TOKEN_SECRET;
});
beforeEach(() => {
  authUser = { id: 'u-1', isAdmin: true, isSuperAdmin: false };
  process.env.CODEX_AGENT_V2 = '1';
  delete process.env.CODEX_AGENT_ALLOWED_USER_IDS;
  delete process.env.CODEX_PREVIEW_START_POLL_MS;
  delete process.env.CODEX_PREVIEW_START_TIMEOUT_MS;
  serviceCalls.length = 0;
  runnerCalls.length = 0;
  publicationCalls.length = 0;
  runnerStatusQueue = null;
  runnerStatusCalls = 0;
  runnerMockPort = 5173;
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/codex', codexRoutes);
  return app;
}

test('Codex router exposes the tokenized preview WebSocket attachment', () => {
  assert.equal(typeof codexRoutes.attachPreviewWebSocketProxy, 'function');
});

test('tokenized preview WebSocket reaches only its runner project', async (t) => {
  process.env.CODEX_PREVIEW_TOKEN_SECRET = 'codex-preview-websocket-test-secret';
  const upstream = http.createServer();
  const upstreamWss = new WebSocket.Server({ server: upstream });
  upstreamWss.on('connection', (socket) => {
    socket.send('vite-connected');
    socket.on('message', (data) => socket.send(`vite:${String(data)}`));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  runnerMockPort = upstream.address().port;

  const proxy = http.createServer(buildApp());
  const binding = codexRoutes.attachPreviewWebSocketProxy(proxy);
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));

  const payload = Buffer.from(JSON.stringify({
    projectId: 'p1',
    userId: 'u-1',
    exp: Date.now() + 60_000,
  })).toString('base64url');
  const signature = crypto
    .createHmac('sha256', process.env.CODEX_PREVIEW_TOKEN_SECRET)
    .update(payload)
    .digest('base64url');
  const token = `${payload}.${signature}`;
  const client = new WebSocket(
    `ws://127.0.0.1:${proxy.address().port}/api/codex/projects/p1/preview/${token}/app/`,
    'vite-hmr',
  );

  t.after(async () => {
    client.terminate();
    binding.close();
    for (const socket of upstreamWss.clients) socket.terminate();
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  });

  const connected = new Promise((resolve) => client.once('message', (data) => resolve(String(data))));
  await once(client, 'open');
  assert.equal(client.protocol, 'vite-hmr');
  assert.equal(await connected, 'vite-connected');

  const echoed = new Promise((resolve) => client.once('message', (data) => resolve(String(data))));
  client.send('ping');
  assert.equal(await echoed, 'vite:ping');
});

test('GET /health responds 200 with enabled=false when the flag is off', async () => {
  delete process.env.CODEX_AGENT_V2;
  const res = await request(buildApp()).get('/api/codex/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, enabled: false, previewOrigin: null });
});

test('GET /health advertises CODEX_PREVIEW_ORIGIN (trailing slash trimmed)', async () => {
  process.env.CODEX_PREVIEW_ORIGIN = 'https://preview.example.com/';
  try {
    const res = await request(buildApp()).get('/api/codex/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.previewOrigin, 'https://preview.example.com');
  } finally {
    delete process.env.CODEX_PREVIEW_ORIGIN;
  }
});

test('GET /access reports flag and user execution access', async () => {
  const res = await request(buildApp()).get('/api/codex/access');
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.canRun, true);
});

test('company association routes persist explicit owner choices and never infer a backfill', async () => {
  const originals = {
    addCompanyConnector: companyAssociationService.addCompanyConnector,
    associationForCompany: companyAssociationService.associationForCompany,
    associateCompany: companyAssociationService.associateCompany,
    assignCompanyConnectors: companyAssociationService.assignCompanyConnectors,
    listOrphans: companyAssociationService.listOrphans,
    removeCompanyConnector: companyAssociationService.removeCompanyConnector,
  };
  const calls = [];
  companyAssociationService.associationForCompany = async (_db, args) => {
    calls.push(['get', args]);
    return {
      company: { id: args.projectId, name: 'Empresa A', organizationId: null },
      association: null,
      candidates: [{ id: 'codex-a', name: 'Runtime A', organizationId: null, status: 'ready' }],
      connectors: [],
      requiresAssociation: true,
    };
  };
  companyAssociationService.associateCompany = async (_db, args) => {
    calls.push(['associate', args]);
    return {
      association: {
        id: 'link-a',
        source: args.source,
        organizationId: null,
        codexProject: { id: args.codexProjectId, name: 'Runtime A', status: 'ready' },
        connectors: [],
      },
    };
  };
  companyAssociationService.assignCompanyConnectors = async (_db, args) => {
    calls.push(['connectors', args]);
    return { connectors: [] };
  };
  companyAssociationService.addCompanyConnector = async (_db, args) => {
    calls.push(['connector-add', args]);
    return { connector: { id: args.connectorAccountId }, changed: true };
  };
  companyAssociationService.removeCompanyConnector = async (_db, args) => {
    calls.push(['connector-remove', args]);
    return { connector: { id: args.connectorAccountId }, changed: true };
  };
  companyAssociationService.listOrphans = async (_db, args) => {
    calls.push(['orphans', args]);
    return { companies: [], codexProjects: [], backfillApplied: false };
  };

  try {
    const state = await request(buildApp())
      .get('/api/codex/company-associations')
      .query({ projectId: 'company-a' });
    assert.equal(state.status, 200);
    assert.equal(state.body.requiresAssociation, true);
    assert.equal(state.headers['cache-control'], 'no-store');

    const linked = await request(buildApp())
      .post('/api/codex/company-associations')
      .send({
        projectId: 'company-a',
        codexProjectId: 'codex-a',
        connectorAccountIds: [],
        source: 'manual',
      });
    assert.equal(linked.status, 201);
    assert.equal(linked.body.association.id, 'link-a');

    const connectors = await request(buildApp())
      .put('/api/codex/company-associations/company-a/connectors')
      .send({ connectorAccountIds: [] });
    assert.equal(connectors.status, 200);

    const connectorAdded = await request(buildApp())
      .post('/api/codex/company-associations/company-a/connectors/gmail-a');
    assert.equal(connectorAdded.status, 200);
    assert.equal(connectorAdded.body.changed, true);

    const connectorRemoved = await request(buildApp())
      .delete('/api/codex/company-associations/company-a/connectors/gmail-a');
    assert.equal(connectorRemoved.status, 200);
    assert.equal(connectorRemoved.body.changed, true);

    const orphans = await request(buildApp())
      .get('/api/codex/company-associations/orphans');
    assert.equal(orphans.status, 200);
    assert.equal(orphans.body.backfillApplied, false);

    for (const [, args] of calls) assert.equal(args.userId, 'u-1');
  } finally {
    companyAssociationService.addCompanyConnector = originals.addCompanyConnector;
    companyAssociationService.associationForCompany = originals.associationForCompany;
    companyAssociationService.associateCompany = originals.associateCompany;
    companyAssociationService.assignCompanyConnectors = originals.assignCompanyConnectors;
    companyAssociationService.listOrphans = originals.listOrphans;
    companyAssociationService.removeCompanyConnector = originals.removeCompanyConnector;
  }
});

test('POST /projects/:id/proactive rejects autonomous execution without isolated access', async () => {
  authUser = { id: 'u-1', isAdmin: false, isSuperAdmin: false };
  const res = await request(buildApp())
    .post('/api/codex/projects/p1/proactive')
    .send({ enabled: true });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'codex_forbidden');
});

test('DELETE business-channel pairing enforces project ownership and maps static grants', async () => {
  const companyRegistry = require('../src/services/codex/company-registry');
  const businessChannels = require('../src/services/codex/business-channels');
  const originals = {
    projectFindFirst: codexDb.codexProject.findFirst,
    ensureCompany: companyRegistry.ensureCompanyForCodexProject,
    revokePairing: businessChannels.revokePairing,
  };
  const calls = [];
  codexDb.codexProject.findFirst = async ({ where }) => (
    where?.id === 'p1' && where?.userId === 'u-1'
      ? { id: 'p1', userId: 'u-1', deletedAt: null }
      : null
  );
  companyRegistry.ensureCompanyForCodexProject = async () => ({
    id: 'company-1',
    userId: 'u-1',
  });
  businessChannels.revokePairing = async (args) => {
    calls.push(args);
    if (args.senderRef === 'static-sender') {
      throw new Error('sender_statically_allowlisted');
    }
    return { id: args.channelId, companyId: args.company.id };
  };

  try {
    const revoked = await request(buildApp())
      .delete('/api/codex/projects/p1/business-channels/channel-1/pair')
      .send({ from: 'dynamic-sender' });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.channel.id, 'channel-1');
    assert.equal(calls[0].company.id, 'company-1');

    const idempotent = await request(buildApp())
      .delete('/api/codex/projects/p1/business-channels/channel-1/pair')
      .send({ from: 'dynamic-sender' });
    assert.equal(idempotent.status, 200);

    const staticGrant = await request(buildApp())
      .delete('/api/codex/projects/p1/business-channels/channel-1/pair')
      .send({ from: 'static-sender' });
    assert.equal(staticGrant.status, 409);
    assert.equal(staticGrant.body.error, 'sender_statically_allowlisted');

    authUser = { id: 'u-2', isAdmin: true, isSuperAdmin: false };
    const foreign = await request(buildApp())
      .delete('/api/codex/projects/p1/business-channels/channel-1/pair')
      .send({ from: 'dynamic-sender' });
    assert.equal(foreign.status, 404);
    assert.equal(calls.length, 3);
  } finally {
    codexDb.codexProject.findFirst = originals.projectFindFirst;
    companyRegistry.ensureCompanyForCodexProject = originals.ensureCompany;
    businessChannels.revokePairing = originals.revokePairing;
  }
});

test('company profile routes return grounded readiness and preserve the owned project brief', async () => {
  const originals = {
    projectFindFirst: codexDb.codexProject.findFirst,
    projectFindUnique: codexDb.codexProject.findUnique,
    projectUpdate: codexDb.codexProject.update,
    socialFindMany: codexDb.socialConnection.findMany,
    userFindUnique: codexDb.user.findUnique,
    companyLinkFindUnique: codexDb.companyCodexProjectLink.findUnique,
    connectorAssignmentFindMany: codexDb.projectConnectorAssignment.findMany,
    transaction: codexDb.$transaction,
    queryRawUnsafe: codexDb.$queryRawUnsafe,
  };
  let project = {
    id: 'p1',
    userId: 'u-1',
    name: 'SiraGPT.COM',
    status: 'ready',
    workspacePath: 'projects/p1',
    brief: { proactive: { enabled: false } },
  };
  codexDb.codexProject.findFirst = async ({ where }) => (
    where?.id === project.id && where?.userId === project.userId ? { ...project } : null
  );
  codexDb.codexProject.findUnique = async ({ where }) => (
    where?.id === project.id ? { ...project } : null
  );
  codexDb.codexProject.update = async ({ data }) => {
    project = { ...project, ...data };
    return { ...project };
  };
  codexDb.socialConnection.findMany = async () => [{ platform: 'linkedin', accountName: '@siragpt' }];
  codexDb.user.findUnique = async () => ({ gmailTokens: null });
  codexDb.companyCodexProjectLink.findUnique = async () => ({ projectId: 'company-1' });
  codexDb.projectConnectorAssignment.findMany = async () => [{
    connectorAccount: {
      id: 'connector-linkedin',
      provider: 'linkedin',
      status: 'connected',
    },
  }];
  codexDb.$transaction = async (operation) => operation(codexDb);
  codexDb.$queryRawUnsafe = async () => [{ locked: 1 }];

  try {
    const initial = await request(buildApp()).get('/api/codex/projects/p1/company-profile');
    assert.equal(initial.status, 200);
    assert.equal(initial.body.company.readiness.evidence.socialConnections[0].platform, 'linkedin');
    assert.equal(initial.body.company.readiness.evidence.gmailConnected, false);
    assert.equal(
      initial.body.company.portfolio.version,
      require('../src/services/codex/company-mission-orchestrator').PORTFOLIO_VERSION,
    );
    assert.equal(initial.body.company.portfolio.missions.length, 9);

    const updated = await request(buildApp())
      .patch('/api/codex/projects/p1/company-profile')
      .send({
        profile: {
          stage: 'existing',
          mission: 'Construir el mejor agente de código empresarial.',
          vision: 'Operar empresas con ejecución verificable.',
        },
      });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.company.profile.stage, 'existing');
    assert.equal(updated.body.company.profile.autonomy.emailReplies, 'review');
    assert.equal(project.brief.proactive.enabled, false);
    assert.match(project.brief.companyProfile.mission, /mejor agente de código/);

    const blockedAuto = await request(buildApp())
      .patch('/api/codex/projects/p1/company-profile')
      .send({ profile: { autonomy: { leadOutreach: 'auto' } } });
    assert.equal(blockedAuto.status, 409);
    assert.equal(blockedAuto.body.error, 'company_auto_confirmation_required');

    const confirmedAuto = await request(buildApp())
      .patch('/api/codex/projects/p1/company-profile')
      .send({ profile: { autonomy: { leadOutreach: 'auto' } }, confirmAuto: true });
    assert.equal(confirmedAuto.status, 200);
    assert.equal(confirmedAuto.body.company.profile.autonomy.leadOutreach, 'auto');

    const emptyOkrs = await request(buildApp()).get('/api/codex/projects/p1/okrs');
    assert.equal(emptyOkrs.status, 200);
    assert.equal(emptyOkrs.body.portfolio.revision, 0);

    const reviewedOkrs = await request(buildApp())
      .put('/api/codex/projects/p1/okrs/review')
      .send({
        expectedRevision: 0,
        rationale: 'CEO Office prioriza activación con una métrica verificable.',
        objectives: [
          {
            id: 'okr-activation',
            title: 'Aumentar activación',
            priority: 2,
            keyResults: [{
              id: 'kr-activation-rate',
              title: 'Elevar la tasa de activación',
              baseline: '20',
              current: '25',
              target: '40',
              unit: '%',
              status: 'on_track',
              progress: 25,
            }],
          },
          {
            id: 'okr-retention',
            title: 'Mejorar retención',
            priority: 1,
            keyResults: [{
              id: 'kr-week-four',
              title: 'Retención a cuatro semanas',
              target: '60',
              unit: '%',
            }],
          },
        ],
      });
    assert.equal(reviewedOkrs.status, 200);
    assert.equal(reviewedOkrs.body.portfolio.revision, 1);
    assert.equal(reviewedOkrs.body.portfolio.objectives[0].id, 'okr-retention');
    assert.equal(reviewedOkrs.body.portfolio.latestReview.source, 'ceo_review');

    const reprioritizedOkrs = await request(buildApp())
      .post('/api/codex/projects/p1/okrs/reprioritize')
      .send({
        expectedRevision: 1,
        orderedIds: ['okr-activation'],
        rationale: 'Activación desbloquea el aprendizaje de retención.',
      });
    assert.equal(reprioritizedOkrs.status, 200);
    assert.equal(reprioritizedOkrs.body.portfolio.revision, 2);
    assert.equal(reprioritizedOkrs.body.portfolio.objectives[0].id, 'okr-activation');
    assert.equal(reprioritizedOkrs.body.portfolio.latestReview.source, 'ceo_reprioritization');

    const staleReview = await request(buildApp())
      .put('/api/codex/projects/p1/okrs/review')
      .send({
        expectedRevision: 1,
        objectives: reprioritizedOkrs.body.portfolio.objectives,
      });
    assert.equal(staleReview.status, 409);
    assert.equal(staleReview.body.error, 'okr_revision_conflict');
  } finally {
    codexDb.codexProject.findFirst = originals.projectFindFirst;
    codexDb.codexProject.findUnique = originals.projectFindUnique;
    codexDb.codexProject.update = originals.projectUpdate;
    codexDb.socialConnection.findMany = originals.socialFindMany;
    codexDb.user.findUnique = originals.userFindUnique;
    codexDb.companyCodexProjectLink.findUnique = originals.companyLinkFindUnique;
    codexDb.projectConnectorAssignment.findMany = originals.connectorAssignmentFindMany;
    codexDb.$transaction = originals.transaction;
    codexDb.$queryRawUnsafe = originals.queryRawUnsafe;
  }
});

test('company operations routes scope every record to the owned user and project', async () => {
  const originals = {
    projectFindFirst: codexDb.codexProject.findFirst,
    leadFindMany: codexDb.codexCompanyLead.findMany,
    leadCount: codexDb.codexCompanyLead.count,
    leadUpdateMany: codexDb.codexCompanyLead.updateMany,
    leadFindFirst: codexDb.codexCompanyLead.findFirst,
    inboxFindMany: codexDb.codexCompanyInboxItem.findMany,
    inboxCount: codexDb.codexCompanyInboxItem.count,
    actionFindMany: codexDb.codexExternalAction.findMany,
    actionCount: codexDb.codexExternalAction.count,
    socialFindMany: codexDb.socialConnection.findMany,
    userFindUnique: codexDb.user.findUnique,
    companyLinkFindUnique: codexDb.companyCodexProjectLink.findUnique,
    connectorAssignmentFindMany: codexDb.projectConnectorAssignment.findMany,
  };
  const scopes = [];
  const project = { id: 'p1', userId: 'u-1', name: 'SiraGPT.COM', brief: {} };
  codexDb.codexProject.findFirst = async ({ where }) => (
    where?.id === project.id && where?.userId === project.userId ? project : null
  );
  codexDb.codexCompanyLead.findMany = async ({ where }) => {
    scopes.push(['lead-list', where]);
    return [{ id: 'lead-1', projectId: 'p1', userId: 'u-1', companyName: 'Alfa' }];
  };
  codexDb.codexCompanyLead.count = async ({ where }) => {
    scopes.push(['lead-count', where]);
    return 1;
  };
  codexDb.codexCompanyLead.updateMany = async ({ where, data }) => {
    scopes.push(['lead-update', where, data]);
    return { count: 1 };
  };
  codexDb.codexCompanyLead.findFirst = async ({ where }) => {
    scopes.push(['lead-read', where]);
    return { id: 'lead-1', projectId: 'p1', userId: 'u-1', email: 'ventas@alfa.example' };
  };
  codexDb.codexCompanyInboxItem.findMany = async ({ where }) => {
    scopes.push(['inbox-list', where]);
    return [];
  };
  codexDb.codexCompanyInboxItem.count = async ({ where }) => {
    scopes.push(['inbox-count', where]);
    return 0;
  };
  codexDb.codexExternalAction.findMany = async ({ where }) => {
    scopes.push(['action-list', where]);
    return [];
  };
  codexDb.codexExternalAction.count = async ({ where }) => {
    scopes.push(['action-count', where]);
    return 0;
  };
  codexDb.socialConnection.findMany = async () => [];
  codexDb.user.findUnique = async () => ({ gmailTokens: null });
  codexDb.companyCodexProjectLink.findUnique = async () => ({ projectId: 'company-1' });
  codexDb.projectConnectorAssignment.findMany = async () => [];

  try {
    const snapshot = await request(buildApp()).get('/api/codex/projects/p1/company-operations');
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.body.operations.counts.leads, 1);

    const updated = await request(buildApp())
      .patch('/api/codex/projects/p1/company-operations/leads/lead-1')
      .send({ email: 'ventas@alfa.example' });
    assert.equal(updated.status, 200);

    const rejectedHeaderInjection = await request(buildApp())
      .patch('/api/codex/projects/p1/company-operations/leads/lead-1')
      .send({ email: 'ventas@alfa.example\r\nBcc: victim@example.com' });
    assert.equal(rejectedHeaderInjection.status, 400);
    assert.equal(rejectedHeaderInjection.body.error, 'validation_failed');

    const socialTriage = await request(buildApp())
      .post('/api/codex/projects/p1/company-operations/triage-social')
      .send({ maxResults: 10 });
    assert.equal(socialTriage.status, 403);
    assert.equal(socialTriage.body.error, 'company_project_not_active');

    for (const [, where] of scopes) {
      assert.equal(where.projectId, 'p1');
      assert.equal(where.userId, 'u-1');
    }
  } finally {
    codexDb.codexProject.findFirst = originals.projectFindFirst;
    codexDb.codexCompanyLead.findMany = originals.leadFindMany;
    codexDb.codexCompanyLead.count = originals.leadCount;
    codexDb.codexCompanyLead.updateMany = originals.leadUpdateMany;
    codexDb.codexCompanyLead.findFirst = originals.leadFindFirst;
    codexDb.codexCompanyInboxItem.findMany = originals.inboxFindMany;
    codexDb.codexCompanyInboxItem.count = originals.inboxCount;
    codexDb.codexExternalAction.findMany = originals.actionFindMany;
    codexDb.codexExternalAction.count = originals.actionCount;
    codexDb.socialConnection.findMany = originals.socialFindMany;
    codexDb.user.findUnique = originals.userFindUnique;
    codexDb.companyCodexProjectLink.findUnique = originals.companyLinkFindUnique;
    codexDb.projectConnectorAssignment.findMany = originals.connectorAssignmentFindMany;
  }
});

test('flag off ⇒ every other route is 404 not_found', async () => {
  delete process.env.CODEX_AGENT_V2;
  const res = await request(buildApp()).post('/api/codex/projects').send({ name: 'X' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});

test('POST /projects validates name and forwards userId to the service', async () => {
  const bad = await request(buildApp()).post('/api/codex/projects').send({});
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'validation_failed');

  const res = await request(buildApp()).post('/api/codex/projects').send({ name: '  Tienda  ' });
  assert.equal(res.status, 201);
  assert.equal(res.body.project.id, 'p1');
  const call = serviceCalls.find((c) => c[0] === 'createProject');
  assert.equal(call[1].userId, 'u-1');
  assert.equal(call[1].name, 'Tienda');
});

test('GET /projects lists own projects; GET /projects/:id 404s for foreign ids', async () => {
  const list = await request(buildApp()).get('/api/codex/projects');
  assert.equal(list.status, 200);
  assert.equal(list.body.projects.length, 1);

  const found = await request(buildApp()).get('/api/codex/projects/p1');
  assert.equal(found.status, 200);
  const missing = await request(buildApp()).get('/api/codex/projects/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'project_not_found');
});

test('publication routes preserve ownership context and support publish plus rollback', async () => {
  const app = buildApp();
  const current = await request(app).get('/api/codex/projects/p1/publication');
  assert.equal(current.status, 200);
  assert.equal(current.headers['cache-control'], 'no-store');
  assert.equal(current.body.publication.url, 'https://demo.apps.example.com');

  const published = await request(app)
    .post('/api/codex/projects/p1/publication')
    .send({ checkpointId: 'cp-1' });
  assert.equal(published.status, 201);
  const publishCall = publicationCalls.find((call) => call[0] === 'publish');
  assert.equal(publishCall[1].userId, 'u-1');
  assert.equal(publishCall[1].projectId, 'p1');
  assert.equal(publishCall[1].checkpointId, 'cp-1');

  const rolledBack = await request(app)
    .post('/api/codex/projects/p1/publication/rollback')
    .send({ releaseId: 'abc1234' });
  assert.equal(rolledBack.status, 200);
  const rollbackCall = publicationCalls.find((call) => call[0] === 'rollback-publication');
  assert.equal(rollbackCall[1].releaseId, 'abc1234');
  assert.equal(rollbackCall[1].userId, 'u-1');
});

test('POST /projects/:id/preview/start proxies the runner and adds devUrl', async () => {
  const res = await request(buildApp()).post('/api/codex/projects/p1/preview/start');
  assert.equal(res.status, 200);
  assert.match(res.body.devUrl, /^\/api\/codex\/projects\/p1\/preview\/.+\/app\/$/);
  assert.equal(res.body.previewStatus.ready, true);
  assert.equal(runnerCalls.at(-1)[0], 'startDev');
  assert.equal(runnerCalls.at(-1)[1], 'p1');
  assert.match(runnerCalls.at(-1)[2].basePath, /^\/api\/codex\/projects\/p1\/preview\/.+\/app\/$/);
});

test('POST /projects/:id/preview/start REUSES a live dev server (same tokenized base)', async () => {
  // First start mints the base; a second start while the server is live must
  // return the SAME base instead of restarting with a fresh token — a restart
  // 404s every asset URL an already-open iframe still holds.
  const app = buildApp();
  const first = await request(app).post('/api/codex/projects/p1/preview/start');
  assert.equal(first.status, 200);
  const liveBase = first.body.basePath;
  runnerStatusQueue = [{ running: true, ready: true, project: 'p1', port: 5173, basePath: liveBase }];
  const startsBefore = runnerCalls.filter((c) => c[0] === 'startDev').length;
  const second = await request(app).post('/api/codex/projects/p1/preview/start');
  assert.equal(second.status, 200);
  assert.equal(second.body.reused, true);
  assert.equal(second.body.basePath, liveBase);
  assert.equal(runnerCalls.filter((c) => c[0] === 'startDev').length, startsBefore, 'no restart on reuse');
});

test('POST /projects/:id/preview/start waits for runner readiness', async () => {
  process.env.CODEX_PREVIEW_START_POLL_MS = '1';
  process.env.CODEX_PREVIEW_START_TIMEOUT_MS = '1000';
  runnerStatusQueue = [
    { running: true, ready: false, project: 'p1' },
    { running: true, ready: true, project: 'p1' },
  ];
  const res = await request(buildApp()).post('/api/codex/projects/p1/preview/start');
  assert.equal(res.status, 200);
  assert.equal(res.body.previewStatus.ready, true);
  assert.equal(runnerStatusCalls, 2);
});

test('GET /projects/:id/preview/status is never cached', async () => {
  runnerStatusQueue = [{ running: false, ready: false, project: 'p1' }];
  const res = await request(buildApp()).get('/api/codex/projects/p1/preview/status');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.body.ready, false);
});

test('tokenized preview proxy strips credentials and forces frame headers', async () => {
  const upstreamHits = [];
  const server = http.createServer((req, res) => {
    upstreamHits.push({ url: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization });
    res.setHeader('Set-Cookie', 'preview=unsafe');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.end(`ok:${req.url}`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  process.env.CODE_RUNNER_DEV_INTERNAL_URL = `http://127.0.0.1:${port}`;
  runnerMockPort = port; // proxy targets the project's runner-assigned port
  try {
    const start = await request(buildApp()).post('/api/codex/projects/p1/preview/start');
    assert.equal(start.status, 200);
    const res = await request(buildApp())
      .get(start.body.previewUrl)
      .set('Cookie', 'sid=secret')
      .set('Authorization', 'Bearer secret');
    assert.equal(res.status, 200);
    assert.match(res.text, /^ok:\/api\/codex\/projects\/p1\/preview\/.+\/app\/$/);
    assert.equal(upstreamHits[0].cookie, undefined);
    assert.equal(upstreamHits[0].authorization, undefined);
    assert.equal(res.headers['set-cookie'], undefined);
    assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
    assert.equal(res.headers['content-security-policy'], "frame-ancestors 'self'");
  } finally {
    delete process.env.CODE_RUNNER_DEV_INTERNAL_URL;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('tokenized preview proxy can override Host header for Vite allowedHosts', async () => {
  const upstreamHits = [];
  const server = http.createServer((req, res) => {
    upstreamHits.push({ host: req.headers.host });
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  process.env.CODE_RUNNER_DEV_INTERNAL_URL = `http://127.0.0.1:${port}`;
  process.env.CODE_RUNNER_DEV_PROXY_HOST_HEADER = `localhost:${port}`;
  runnerMockPort = port; // proxy targets the project's runner-assigned port
  try {
    const start = await request(buildApp()).post('/api/codex/projects/p1/preview/start');
    assert.equal(start.status, 200);
    const res = await request(buildApp()).get(start.body.previewUrl);
    assert.equal(res.status, 200);
    assert.equal(upstreamHits[0].host, `localhost:${port}`);
  } finally {
    delete process.env.CODE_RUNNER_DEV_INTERNAL_URL;
    delete process.env.CODE_RUNNER_DEV_PROXY_HOST_HEADER;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('preview routes 404 on foreign project ids (ownership gate)', async () => {
  const res = await request(buildApp()).post('/api/codex/projects/nope/preview/start');
  assert.equal(res.status, 404);
});

test('POST /projects/:id/export mirrors via the runner and returns hostPath', async () => {
  const res = await request(buildApp()).post('/api/codex/projects/p1/export');
  assert.equal(res.status, 200);
  assert.equal(res.body.files, 5);
  assert.equal(res.body.hostPath, '.codex-workspaces/p1');
  assert.deepEqual(runnerCalls.at(-1), ['exportWorkspace', 'p1']);
});

test('export route 404s on foreign project ids (ownership gate)', async () => {
  const res = await request(buildApp()).post('/api/codex/projects/nope/export');
  assert.equal(res.status, 404);
});

test('GET /projects/:id/files lists source files (sorted) via the runner', async () => {
  const res = await request(buildApp()).get('/api/codex/projects/p1/files');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.files, ['index.html', 'package.json', 'src/main.tsx']);
  assert.deepEqual(runnerCalls.at(-1), ['exec', 'p1', ['git', 'ls-files', '-co', '--exclude-standard']]);
});

test('GET /projects/:id/file reads a file via the runner; requires ?path', async () => {
  const missing = await request(buildApp()).get('/api/codex/projects/p1/file');
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, 'path_required');

  const res = await request(buildApp()).get('/api/codex/projects/p1/file?path=index.html');
  assert.equal(res.status, 200);
  assert.equal(res.body.content, '<html></html>');
  assert.deepEqual(runnerCalls.at(-1), ['readFile', 'p1', 'index.html']);
});

test('files/file routes 404 on foreign project ids (ownership gate)', async () => {
  assert.equal((await request(buildApp()).get('/api/codex/projects/nope/files')).status, 404);
  assert.equal((await request(buildApp()).get('/api/codex/projects/nope/file?path=x')).status, 404);
});
