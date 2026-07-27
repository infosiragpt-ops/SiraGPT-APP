'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const evidenceLedger = require('../src/services/codex/mission-evidence-ledger');

function fakeStore(brief = {}) {
  const state = {
    project: {
      id: 'project-1',
      userId: 'user-1',
      name: 'SiraGPT',
      brief: structuredClone(brief),
    },
  };
  const read = () => structuredClone(state.project);
  const prisma = {
    codexProject: {
      findFirst: async () => read(),
      findUnique: async () => read(),
      update: async ({ data }) => {
        state.project = { ...state.project, ...structuredClone(data) };
        return read();
      },
    },
  };
  return { state, prisma, project: read() };
}

function fakeDurableStore(brief = {}) {
  const project = {
    id: 'project-durable',
    userId: 'user-1',
    name: 'SiraGPT',
    brief: structuredClone(brief),
  };
  const state = {
    missions: [],
    artifacts: [],
    reports: [],
    approvals: [],
  };
  const hydrateMission = (mission) => ({
    ...structuredClone(mission),
    artifacts: state.artifacts
      .filter((artifact) => artifact.missionId === mission.id)
      .map((artifact) => structuredClone(artifact)),
    approvals: state.approvals
      .filter((approval) => approval.missionId === mission.id)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((approval) => structuredClone(approval)),
  });
  const matches = (item, where) => Object.entries(where || {})
    .every(([key, value]) => item[key] === value);
  const prisma = {
    codexProject: {},
    codexMission: {
      findFirst: async ({ where }) => {
        const mission = state.missions.find((item) => matches(item, where));
        return mission ? hydrateMission(mission) : null;
      },
      findMany: async ({ where }) => state.missions
        .filter((item) => matches(item, where))
        .map(hydrateMission),
      create: async ({ data }) => {
        const mission = {
          id: `mission-${state.missions.length + 1}`,
          ...structuredClone(data),
          createdAt: data.createdAt || new Date(),
          updatedAt: data.createdAt || new Date(),
        };
        state.missions.push(mission);
        return structuredClone(mission);
      },
      update: async ({ where, data }) => {
        const index = state.missions.findIndex((item) => item.id === where.id);
        state.missions[index] = {
          ...state.missions[index],
          ...structuredClone(data),
          updatedAt: new Date(),
        };
        return structuredClone(state.missions[index]);
      },
    },
    codexMissionArtifact: {
      upsert: async ({ where, create, update }) => {
        const key = where.missionId_artifactKey_version;
        const index = state.artifacts.findIndex((item) => (
          item.missionId === key.missionId
          && item.artifactKey === key.artifactKey
          && item.version === key.version
        ));
        if (index >= 0) {
          state.artifacts[index] = {
            ...state.artifacts[index],
            ...structuredClone(update),
            updatedAt: new Date(),
          };
          return structuredClone(state.artifacts[index]);
        }
        const artifact = {
          id: `artifact-${state.artifacts.length + 1}`,
          ...structuredClone(create),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        state.artifacts.push(artifact);
        return structuredClone(artifact);
      },
    },
    codexActivityReport: {
      findFirst: async ({ where }) => {
        const report = state.reports.find((item) => matches(item, where));
        return report ? structuredClone(report) : null;
      },
      findMany: async ({ where }) => state.reports
        .filter((item) => matches(item, where))
        .map((item) => structuredClone(item)),
      create: async ({ data }) => {
        const report = {
          id: `report-${state.reports.length + 1}`,
          ...structuredClone(data),
          createdAt: data.createdAt || new Date(),
          updatedAt: data.createdAt || new Date(),
        };
        state.reports.push(report);
        return structuredClone(report);
      },
    },
    codexCeoApproval: {
      create: async ({ data }) => {
        const approval = {
          id: `approval-${state.approvals.length + 1}`,
          ...structuredClone(data),
          createdAt: data.createdAt || new Date(),
        };
        state.approvals.push(approval);
        return structuredClone(approval);
      },
    },
  };
  prisma.$transaction = async (operation) => operation(prisma);
  return { state, prisma, project };
}

test('sync backfills durable mission records from the progress ledger', async () => {
  const { prisma, project, state } = fakeStore({
    ledger: [{
      runId: 'run-1',
      missionId: 'code-excellence',
      department: 'Producto e Ingeniería',
      outcome: 'passed',
      task: 'Corregir el panel de archivos',
      checkpointSha: 'abc123',
      diffstat: { additions: 18, deletions: 4, filesChanged: 3 },
      acceptance: [{
        criterion: 'La interfaz funciona',
        passed: true,
        evidence: 'Playwright pasó.',
      }],
      learnings: ['La vista quedó validada.'],
      createdAt: '2026-07-27T10:00:00.000Z',
    }],
  });

  const result = await evidenceLedger.syncMissionEvidence({ prisma, project });

  assert.equal(result.summary.missions, 1);
  assert.equal(result.summary.pendingReview, 1);
  assert.equal(result.records[0].missionId, 'code-excellence');
  assert.equal(result.records[0].author, 'Producto e Ingeniería · SiraGPT Agent');
  assert.equal(result.records[0].createdAt, '2026-07-27T10:00:00.000Z');
  assert.equal(result.records[0].deliverables.length, 3);
  assert.equal(result.records[0].evidence[0].passed, true);
  assert.equal(state.project.brief.missionEvidence.version, 1);
});

test('run completion stores bounded evidence and preserves an existing CEO review', async () => {
  const { prisma, project, state } = fakeStore({
    missionEvidence: {
      records: [{
        id: 'run:run-2',
        runId: 'run-2',
        missionId: 'company-purpose',
        missionTitle: 'Definir propósito',
        department: 'CEO Office',
        status: 'blocked',
        summary: 'Anterior',
        author: 'SiraGPT Agent',
        createdAt: '2026-07-26T10:00:00.000Z',
        updatedAt: '2026-07-26T10:00:00.000Z',
        ceoReview: {
          status: 'changes_requested',
          reviewedAt: '2026-07-26T11:00:00.000Z',
          reviewedBy: 'Luis',
          note: 'Aterrizar la métrica.',
        },
      }],
      reports: [],
    },
  });

  const stored = await evidenceLedger.recordMissionCompletion({
    prisma,
    project,
    runId: 'run-2',
    missionId: 'company-purpose',
    missionTitle: 'Definir propósito',
    department: 'CEO Office',
    outcome: 'passed',
    executiveSummary: {
      result: 'Misión documentada.',
      impact: '1 archivo actualizado.',
      evidence: ['token=super-secret pasó la prueba'],
      checkpointSha: 'def456',
      diffstat: { filesChanged: 1, additions: 5, deletions: 0 },
    },
    acceptance: [{
      criterion: 'La misión es medible',
      passed: true,
      evidence: 'Métrica incluida.',
    }],
    now: new Date('2026-07-27T11:00:00.000Z'),
  });

  assert.equal(stored.status, 'completed');
  assert.equal(stored.ceoReview.status, 'changes_requested');
  assert.equal(stored.ceoReview.reviewedBy, 'Luis');
  assert.match(stored.evidence[0].detail, /token=\[REDACTED\]/);
  assert.equal(state.project.brief.missionEvidence.records.length, 1);
});

test('CEO review is tenant-scoped and updates the durable record', async () => {
  const { prisma, project } = fakeStore({
    ledger: [{
      runId: 'run-review',
      department: 'Marketing',
      outcome: 'passed',
      task: 'Preparar contenido',
      createdAt: '2026-07-27T10:00:00.000Z',
    }],
  });

  const updated = await evidenceLedger.reviewMissionRecord({
    prisma,
    project,
    recordId: 'run:run-review',
    status: 'approved',
    reviewer: 'Luis',
    note: 'Evidencia suficiente.',
    now: new Date('2026-07-27T12:00:00.000Z'),
  });

  assert.equal(updated.ceoReview.status, 'approved');
  assert.equal(updated.ceoReview.reviewedBy, 'Luis');
  assert.equal(updated.ceoReview.reviewedAt, '2026-07-27T12:00:00.000Z');
  assert.equal(updated.ceoReview.note, 'Evidencia suficiente.');
});

test('activity email reports remain drafts without connection or permission', async () => {
  const first = fakeStore({
    ledger: [{
      runId: 'run-report',
      department: 'CEO Office',
      outcome: 'passed',
      task: 'Preparar plan',
      createdAt: '2026-07-27T10:00:00.000Z',
    }],
  });
  const now = new Date('2026-07-27T13:00:00.000Z');

  const disconnected = await evidenceLedger.createActivityReport({
    prisma: first.prisma,
    project: first.project,
    companyContext: {
      readiness: { evidence: { gmailConnected: false } },
      safeguards: { emailReplies: 'review' },
    },
    requestEmail: true,
    confirmEmailQueue: true,
    now,
  });

  assert.equal(disconnected.status, 'draft');
  assert.equal(disconnected.delivery.status, 'blocked_connection');
  assert.equal(disconnected.delivery.sentAt, null);

  const second = fakeStore(first.state.project.brief);
  const pending = await evidenceLedger.createActivityReport({
    prisma: second.prisma,
    project: second.project,
    companyContext: {
      readiness: { evidence: { gmailConnected: true } },
      safeguards: { emailReplies: 'review' },
    },
    requestEmail: true,
    confirmEmailQueue: false,
    now,
  });

  assert.equal(pending.status, 'draft');
  assert.equal(pending.delivery.status, 'pending_permission');
  assert.equal(pending.delivery.sentAt, null);
});

test('connected and explicitly permitted activity email only enters the queue', async () => {
  const { prisma, project } = fakeStore({
    ledger: [{
      runId: 'run-queued',
      department: 'Ventas',
      outcome: 'passed',
      task: 'Investigar prospectos',
      createdAt: '2026-07-27T10:00:00.000Z',
    }],
  });

  const queued = await evidenceLedger.createActivityReport({
    prisma,
    project,
    companyContext: {
      readiness: { evidence: { gmailConnected: true } },
      safeguards: { emailReplies: 'review' },
    },
    requestEmail: true,
    confirmEmailQueue: true,
    now: new Date('2026-07-27T14:00:00.000Z'),
  });

  assert.equal(queued.status, 'queued');
  assert.equal(queued.delivery.status, 'queued');
  assert.equal(queued.delivery.permissionGranted, true);
  assert.equal(queued.delivery.queuedAt, '2026-07-27T14:00:00.000Z');
  assert.equal(queued.delivery.sentAt, null);
  assert.match(queued.delivery.reason, /no envía mensajes/i);
});

test('disabled email policy cannot be overridden by queue confirmation', () => {
  const delivery = evidenceLedger.reportDelivery({
    requestEmail: true,
    confirmEmailQueue: true,
    companyContext: {
      readiness: { evidence: { gmailConnected: true } },
      safeguards: { emailReplies: 'off' },
    },
    now: new Date('2026-07-27T14:00:00.000Z'),
  });

  assert.equal(delivery.status, 'blocked_policy');
  assert.equal(delivery.permissionGranted, false);
  assert.equal(delivery.sentAt, null);
});

test('database models persist versioned missions, artifacts, source and hashes', async () => {
  const { prisma, project, state } = fakeDurableStore({
    ledger: [{
      runId: 'run-db',
      missionId: 'code-excellence',
      department: 'Producto e Ingeniería',
      outcome: 'passed',
      task: 'Entregar el panel durable',
      checkpointSha: 'deadbeef',
      acceptance: [{
        criterion: 'Persistencia entre dispositivos',
        passed: true,
        evidence: 'Lectura recuperada desde PostgreSQL.',
      }],
      createdAt: '2026-07-27T15:00:00.000Z',
    }],
  });

  const ledger = await evidenceLedger.syncMissionEvidence({ prisma, project });
  await evidenceLedger.syncMissionEvidence({ prisma, project });

  assert.equal(state.missions.length, 1);
  assert.equal(state.artifacts.length, 3);
  assert.equal(ledger.records[0].source, 'progress_ledger');
  assert.equal(ledger.records[0].version, 1);
  assert.match(ledger.records[0].contentHash, /^[a-f0-9]{64}$/);
  assert.ok(state.artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.contentHash)));
});

test('database sync imports legacy activity report drafts without dispatching them', async () => {
  const { prisma, project, state } = fakeDurableStore({
    missionEvidence: {
      records: [],
      reports: [{
        id: 'activity:legacy',
        title: 'Resumen heredado',
        summary: 'Actividad previa a la migración.',
        author: 'CEO Office',
        createdAt: '2026-07-26T12:00:00.000Z',
        period: {
          from: '2026-07-20T12:00:00.000Z',
          to: '2026-07-26T12:00:00.000Z',
        },
        counts: { missions: 1, completed: 1 },
        status: 'draft',
        delivery: {
          status: 'not_requested',
          reason: 'Borrador local.',
        },
      }],
    },
  });

  const ledger = await evidenceLedger.syncMissionEvidence({ prisma, project });

  assert.equal(state.reports.length, 1);
  assert.equal(ledger.reports[0].source, 'project_brief_migration');
  assert.equal(ledger.reports[0].delivery.status, 'not_requested');
  assert.equal(ledger.reports[0].delivery.sentAt, null);
  assert.match(ledger.reports[0].contentHash, /^[a-f0-9]{64}$/);
});

test('database CEO decisions are append-only and bound to the reviewed hash', async () => {
  const { prisma, project, state } = fakeDurableStore({
    ledger: [{
      runId: 'run-review-db',
      department: 'CEO Office',
      outcome: 'passed',
      task: 'Preparar evidencia',
      createdAt: '2026-07-27T15:00:00.000Z',
    }],
  });
  const ledger = await evidenceLedger.syncMissionEvidence({ prisma, project });
  const mission = ledger.records[0];

  await evidenceLedger.reviewMissionRecord({
    prisma,
    project,
    recordId: mission.id,
    status: 'changes_requested',
    reviewer: 'CEO',
    note: 'Agregar fuente.',
    now: new Date('2026-07-27T16:00:00.000Z'),
  });
  const rejected = await evidenceLedger.reviewMissionRecord({
    prisma,
    project,
    recordId: mission.id,
    status: 'rejected',
    reviewer: 'CEO',
    note: 'La evidencia no es suficiente.',
    now: new Date('2026-07-27T17:00:00.000Z'),
  });

  assert.equal(state.approvals.length, 2);
  assert.equal(state.approvals[0].resourceHash, mission.contentHash);
  assert.equal(state.approvals[1].resourceHash, mission.contentHash);
  assert.equal(rejected.ceoReview.status, 'rejected');
  assert.equal(rejected.ceoReview.note, 'La evidencia no es suficiente.');
});

test('a changed mission creates a new version and makes the previous approval stale', async () => {
  const { prisma, project, state } = fakeDurableStore({
    ledger: [{
      runId: 'run-versioned',
      department: 'Producto e Ingeniería',
      outcome: 'passed',
      task: 'Primera entrega',
      createdAt: '2026-07-27T15:00:00.000Z',
    }],
  });
  const first = await evidenceLedger.syncMissionEvidence({ prisma, project });
  await evidenceLedger.reviewMissionRecord({
    prisma,
    project,
    recordId: first.records[0].id,
    status: 'approved',
    reviewer: 'CEO',
    now: new Date('2026-07-27T16:00:00.000Z'),
  });

  project.brief.ledger[0].task = 'Segunda entrega corregida';
  project.brief.ledger[0].learnings = ['Se agregó la fuente requerida.'];
  const second = await evidenceLedger.syncMissionEvidence({ prisma, project });

  assert.equal(state.missions.length, 1);
  assert.equal(second.records[0].version, 2);
  assert.notEqual(second.records[0].contentHash, first.records[0].contentHash);
  assert.equal(second.records[0].ceoReview.status, 'pending');
  assert.ok(state.artifacts.some((artifact) => artifact.version === 1));
  assert.ok(state.artifacts.some((artifact) => artifact.version === 2));
});

test('progress-ledger backfill never downgrades richer run-completion evidence', async () => {
  const { prisma, project, state } = fakeDurableStore({
    ledger: [{
      runId: 'run-rich',
      department: 'Producto e Ingeniería',
      outcome: 'passed',
      task: 'Entrega registrada en el ledger',
      createdAt: '2026-07-27T15:00:00.000Z',
    }],
  });
  const completed = await evidenceLedger.recordMissionCompletion({
    prisma,
    project,
    runId: 'run-rich',
    missionId: 'code-excellence',
    missionTitle: 'Entrega verificada por el runtime',
    department: 'Producto e Ingeniería',
    outcome: 'passed',
    executiveSummary: {
      result: 'Implementación terminada.',
      impact: 'Prueba de navegador aprobada.',
      evidence: ['Playwright 1/1.'],
      checkpointSha: 'abc123',
    },
    now: new Date('2026-07-27T16:00:00.000Z'),
  });

  const synced = await evidenceLedger.syncMissionEvidence({ prisma, project });

  assert.equal(state.missions.length, 1);
  assert.equal(synced.records[0].source, 'run_completion');
  assert.equal(synced.records[0].version, completed.version);
  assert.equal(synced.records[0].contentHash, completed.contentHash);
  assert.equal(synced.records[0].missionTitle, 'Entrega verificada por el runtime');
});

test('database activity report stays queued without sending and carries an integrity hash', async () => {
  const { prisma, project, state } = fakeDurableStore({
    ledger: [{
      runId: 'run-report-db',
      department: 'Ventas',
      outcome: 'passed',
      task: 'Preparar reporte',
      createdAt: '2026-07-27T15:00:00.000Z',
    }],
  });
  await evidenceLedger.syncMissionEvidence({ prisma, project });

  const report = await evidenceLedger.createActivityReport({
    prisma,
    project,
    companyContext: {
      readiness: { evidence: { gmailConnected: true } },
      safeguards: { emailReplies: 'review' },
    },
    requestEmail: true,
    confirmEmailQueue: true,
    now: new Date('2026-07-27T18:00:00.000Z'),
  });

  assert.equal(state.reports.length, 1);
  assert.equal(report.status, 'queued');
  assert.equal(report.delivery.status, 'queued');
  assert.equal(report.delivery.sentAt, null);
  assert.equal(report.source, 'mission_evidence');
  assert.match(report.contentHash, /^[a-f0-9]{64}$/);
});
