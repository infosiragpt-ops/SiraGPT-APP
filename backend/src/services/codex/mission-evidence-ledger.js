'use strict';

const crypto = require('node:crypto');
const { mutateProjectBrief } = require('./project-brief-store');

const LEDGER_VERSION = 1;
const MAX_MISSION_RECORDS = 160;
const MAX_ACTIVITY_REPORTS = 60;
const MAX_DELIVERABLES = 12;
const MAX_EVIDENCE = 16;
const REVIEW_STATUSES = new Set(['pending', 'approved', 'changes_requested', 'rejected']);
const RECORD_STATUSES = new Set(['completed', 'blocked']);
const DELIVERY_STATUSES = new Set([
  'not_requested',
  'blocked_connection',
  'blocked_policy',
  'pending_permission',
  'queued',
]);

const SECRET_PATTERN = /((?:api[_-]?key|authorization|bearer|password|passwd|secret|token|cookie|private[_-]?key))\s*[:=]\s*[^\s,;]+/gi;

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function canonicalValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      if (value[key] !== undefined) result[key] = canonicalValue(value[key]);
      return result;
    }, {});
}

function contentHash(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalValue(value)))
    .digest('hex');
}

function boundedText(value, max = 600) {
  return typeof value === 'string'
    ? value.replace(SECRET_PATTERN, '$1=[REDACTED]').trim().slice(0, max)
    : '';
}

function isoDate(value, fallback = null) {
  const date = value instanceof Date ? value : new Date(value || '');
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function slug(value) {
  return boundedText(value, 120)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
}

function normalizeReview(value) {
  const source = asRecord(value);
  const status = REVIEW_STATUSES.has(source.status) ? source.status : 'pending';
  return {
    status,
    reviewedAt: status === 'pending' ? null : isoDate(source.reviewedAt),
    reviewedBy: status === 'pending' ? null : boundedText(source.reviewedBy, 120) || 'CEO Office',
    note: boundedText(source.note, 1_000) || null,
  };
}

function normalizeDeliverables(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((value, index) => {
      const source = asRecord(value);
      const name = boundedText(source.name || source.label, 180);
      if (!name) return null;
      return {
        id: boundedText(source.id, 180) || `deliverable-${index + 1}`,
        name,
        type: boundedText(source.type, 60) || 'report',
        ref: boundedText(source.ref, 500) || null,
        status: source.status === 'verified' ? 'verified' : 'recorded',
      };
    })
    .filter(Boolean)
    .slice(0, MAX_DELIVERABLES);
}

function normalizeEvidence(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((value, index) => {
      const source = typeof value === 'string' ? { detail: value } : asRecord(value);
      const detail = boundedText(source.detail || source.evidence, 900);
      if (!detail) return null;
      return {
        id: boundedText(source.id, 180) || `evidence-${index + 1}`,
        label: boundedText(source.label, 160) || 'Evidencia',
        detail,
        kind: boundedText(source.kind, 60) || 'verification',
        passed: typeof source.passed === 'boolean' ? source.passed : null,
      };
    })
    .filter(Boolean)
    .slice(0, MAX_EVIDENCE);
}

function normalizeMissionRecord(value) {
  const source = asRecord(value);
  const runId = boundedText(source.runId, 180);
  const id = boundedText(source.id, 220) || (runId ? `run:${runId}` : '');
  if (!id) return null;
  const createdAt = isoDate(source.createdAt, new Date().toISOString());
  const missionTitle = boundedText(source.missionTitle || source.task, 220) || 'Trabajo empresarial';
  return {
    id,
    missionId: boundedText(source.missionId, 120) || 'interactive',
    missionTitle,
    objective: boundedText(source.objective, 2_000) || missionTitle,
    department: boundedText(source.department, 140) || 'CEO Office',
    status: RECORD_STATUSES.has(source.status) ? source.status : 'blocked',
    summary: boundedText(source.summary, 2_000) || 'Actividad registrada sin resumen adicional.',
    author: boundedText(source.author, 140) || 'SiraGPT Agent',
    runId: runId || null,
    source: boundedText(source.source, 80) || 'project_brief_legacy',
    sourceRef: boundedText(source.sourceRef, 220) || (runId ? `run:${runId}` : id),
    version: Math.max(1, Number.parseInt(source.version, 10) || 1),
    contentHash: boundedText(source.contentHash, 128) || null,
    createdAt,
    updatedAt: isoDate(source.updatedAt, createdAt),
    deliverables: normalizeDeliverables(source.deliverables),
    evidence: normalizeEvidence(source.evidence),
    ceoReview: normalizeReview(source.ceoReview),
  };
}

function normalizeDelivery(value) {
  const source = asRecord(value);
  const status = DELIVERY_STATUSES.has(source.status) ? source.status : 'not_requested';
  return {
    channel: 'email',
    status,
    connectionReady: source.connectionReady === true,
    permissionGranted: source.permissionGranted === true,
    permissionMode: ['review', 'auto', 'off'].includes(source.permissionMode)
      ? source.permissionMode
      : 'review',
    queuedAt: status === 'queued' ? isoDate(source.queuedAt) : null,
    sentAt: null,
    reason: boundedText(source.reason, 500) || null,
  };
}

function normalizeActivityReport(value) {
  const source = asRecord(value);
  const id = boundedText(source.id, 220);
  if (!id) return null;
  const createdAt = isoDate(source.createdAt, new Date().toISOString());
  const counts = asRecord(source.counts);
  return {
    id,
    title: boundedText(source.title, 220) || 'Resumen de actividad',
    summary: boundedText(source.summary, 6_000) || 'Sin actividad registrada en el periodo.',
    author: boundedText(source.author, 140) || 'CEO Office',
    source: boundedText(source.source, 80) || 'project_brief_legacy',
    sourceRef: boundedText(source.sourceRef, 220) || id,
    version: Math.max(1, Number.parseInt(source.version, 10) || 1),
    contentHash: boundedText(source.contentHash, 128) || null,
    createdAt,
    period: {
      from: isoDate(source.period?.from, createdAt),
      to: isoDate(source.period?.to, createdAt),
    },
    counts: {
      missions: Math.max(0, Number(counts.missions) || 0),
      completed: Math.max(0, Number(counts.completed) || 0),
      blocked: Math.max(0, Number(counts.blocked) || 0),
      pendingReview: Math.max(0, Number(counts.pendingReview) || 0),
      approved: Math.max(0, Number(counts.approved) || 0),
    },
    status: source.status === 'queued' ? 'queued' : 'draft',
    delivery: normalizeDelivery(source.delivery),
  };
}

function normalizeStore(value) {
  const source = asRecord(value);
  const byRecordId = new Map();
  for (const valueItem of Array.isArray(source.records) ? source.records : []) {
    const record = normalizeMissionRecord(valueItem);
    if (record) byRecordId.set(record.id, record);
  }
  const byReportId = new Map();
  for (const valueItem of Array.isArray(source.reports) ? source.reports : []) {
    const report = normalizeActivityReport(valueItem);
    if (report) byReportId.set(report.id, report);
  }
  return {
    version: LEDGER_VERSION,
    records: [...byRecordId.values()].slice(-MAX_MISSION_RECORDS),
    reports: [...byReportId.values()].slice(-MAX_ACTIVITY_REPORTS),
  };
}

function readMissionEvidence(project) {
  return normalizeStore(asRecord(project?.brief).missionEvidence);
}

function inferMissionId(entry) {
  const explicit = boundedText(entry?.missionId, 120);
  if (explicit) return explicit;
  const source = `${entry?.department || ''} ${entry?.task || ''}`.toLowerCase();
  if (/marketing|social|redes/.test(source)) return 'social-operations';
  if (/ventas|sales|lead|prospect/.test(source)) return 'sales-operations';
  if (/cliente|soporte|inbox|correo|email/.test(source)) return 'email-operations';
  if (/infraestructura|orquest|agent/.test(source)) return 'agent-orchestration';
  if (/producto|ingenier|c[oó]digo|code/.test(source)) return 'code-excellence';
  if (/ceo|misi[oó]n|visi[oó]n/.test(source)) return 'company-purpose';
  return `activity-${slug(entry?.department || 'company') || 'company'}`;
}

function missionTitleFor(entry) {
  const task = boundedText(entry?.task, 220);
  if (task) return task;
  const titles = {
    'social-operations': 'Operar redes con contexto',
    'sales-operations': 'Construir el sistema comercial',
    'email-operations': 'Atender el correo del negocio',
    'agent-orchestration': 'Escalar la ingeniería por agentes',
    'code-excellence': 'Elevar el agente de código',
    'company-purpose': 'Consolidar misión y visión',
  };
  return titles[inferMissionId(entry)] || 'Trabajo empresarial';
}

function recordFromProgressEntry(entry) {
  const normalizedDiff = {
    additions: Math.max(0, Number(entry?.diffstat?.additions) || 0),
    deletions: Math.max(0, Number(entry?.diffstat?.deletions) || 0),
    filesChanged: Math.max(0, Number(entry?.diffstat?.filesChanged) || 0),
  };
  const deliverables = [{
    id: `report:${entry.runId}`,
    name: 'Resumen ejecutivo de actividad',
    type: 'report',
    ref: `run:${entry.runId}`,
    status: 'recorded',
  }];
  if (entry.checkpointSha) {
    deliverables.push({
      id: `checkpoint:${entry.checkpointSha}`,
      name: 'Checkpoint Git verificado',
      type: 'checkpoint',
      ref: entry.checkpointSha,
      status: entry.outcome === 'passed' ? 'verified' : 'recorded',
    });
  }
  if (normalizedDiff.filesChanged > 0) {
    deliverables.push({
      id: `workspace:${entry.runId}`,
      name: `${normalizedDiff.filesChanged} archivo(s) actualizado(s)`,
      type: 'workspace_change',
      ref: `+${normalizedDiff.additions}/-${normalizedDiff.deletions}`,
      status: entry.outcome === 'passed' ? 'verified' : 'recorded',
    });
  }
  const evidence = [
    ...(Array.isArray(entry.acceptance) ? entry.acceptance.map((item, index) => ({
      id: `acceptance-${index + 1}`,
      label: boundedText(item?.criterion, 160) || 'Criterio de aceptación',
      detail: boundedText(item?.evidence, 900) || (item?.passed ? 'Criterio aprobado.' : 'Criterio pendiente.'),
      kind: 'acceptance',
      passed: item?.passed === true,
    })) : []),
    ...(Array.isArray(entry.learnings) ? entry.learnings.map((learning, index) => ({
      id: `learning-${index + 1}`,
      label: 'Aprendizaje',
      detail: learning,
      kind: 'learning',
      passed: null,
    })) : []),
  ];
  return normalizeMissionRecord({
    id: `run:${entry.runId}`,
    missionId: inferMissionId(entry),
    missionTitle: missionTitleFor(entry),
    department: entry.department,
    status: entry.outcome === 'passed' ? 'completed' : 'blocked',
    summary: Array.isArray(entry.learnings) && entry.learnings.length
      ? entry.learnings.join(' ')
      : `${missionTitleFor(entry)} terminó con estado ${entry.outcome || 'desconocido'}.`,
    author: `${boundedText(entry.department, 120) || 'CEO Office'} · SiraGPT Agent`,
    runId: entry.runId,
    createdAt: entry.createdAt,
    updatedAt: entry.createdAt,
    deliverables,
    evidence,
    ceoReview: { status: 'pending' },
  });
}

function mergeProgressRecords(store, ledger) {
  const byId = new Map(store.records.map((record) => [record.id, record]));
  for (const entry of Array.isArray(ledger) ? ledger : []) {
    if (!entry?.runId) continue;
    const candidate = recordFromProgressEntry(entry);
    const existing = byId.get(candidate.id);
    byId.set(candidate.id, existing
      ? { ...candidate, ...existing, ceoReview: normalizeReview(existing.ceoReview) }
      : candidate);
  }
  return {
    ...store,
    records: [...byId.values()]
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .slice(-MAX_MISSION_RECORDS),
  };
}

function summarizeStore(store) {
  const records = store.records;
  return {
    version: LEDGER_VERSION,
    summary: {
      missions: records.length,
      completed: records.filter((record) => record.status === 'completed').length,
      blocked: records.filter((record) => record.status === 'blocked').length,
      pendingReview: records.filter((record) => record.ceoReview.status === 'pending').length,
      approved: records.filter((record) => record.ceoReview.status === 'approved').length,
      reports: store.reports.length,
      emailQueued: store.reports.filter((report) => report.delivery.status === 'queued').length,
    },
    records: [...records].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    reports: [...store.reports].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
  };
}

function durableModelsReady(prisma) {
  return Boolean(
    prisma?.codexMission
    && prisma?.codexMissionArtifact
    && prisma?.codexActivityReport
    && prisma?.codexCeoApproval,
  );
}

function missionHashPayload(record) {
  return {
    missionId: record.missionId,
    missionTitle: record.missionTitle,
    objective: record.objective,
    department: record.department,
    status: record.status,
    summary: record.summary,
    author: record.author,
    runId: record.runId,
    source: record.source,
    sourceRef: record.sourceRef,
    deliverables: record.deliverables,
    evidence: record.evidence,
  };
}

function artifactRowsFromRecord(record, missionVersion) {
  const deliverables = record.deliverables.map((deliverable) => {
    const payload = {
      kind: 'deliverable',
      id: deliverable.id,
      name: deliverable.name,
      type: deliverable.type,
      ref: deliverable.ref,
      status: deliverable.status,
    };
    return {
      artifactKey: `deliverable:${deliverable.id}`,
      name: deliverable.name,
      type: deliverable.type,
      status: deliverable.status,
      source: record.source,
      sourceRef: deliverable.ref,
      version: missionVersion,
      contentHash: contentHash(payload),
      storageRef: deliverable.ref,
      metadata: payload,
    };
  });
  const evidence = record.evidence.map((item) => {
    const payload = {
      kind: 'evidence',
      id: item.id,
      label: item.label,
      detail: item.detail,
      evidenceKind: item.kind,
      passed: item.passed,
    };
    return {
      artifactKey: `evidence:${item.id}`,
      name: item.label,
      type: `evidence:${item.kind}`,
      status: item.passed === false ? 'recorded' : 'verified',
      source: record.source,
      sourceRef: record.sourceRef,
      version: missionVersion,
      contentHash: contentHash(payload),
      storageRef: null,
      metadata: payload,
    };
  });
  return [...deliverables, ...evidence];
}

function latestApprovalFor(resource, approvals) {
  const match = (Array.isArray(approvals) ? approvals : [])
    .find((approval) => approval.resourceHash === resource.contentHash);
  if (!match) return normalizeReview({ status: 'pending' });
  return normalizeReview({
    status: match.decision,
    reviewedAt: match.createdAt,
    reviewedBy: match.reviewerName,
    note: match.note,
  });
}

function dbMissionToRecord(mission) {
  const deliverables = [];
  const evidence = [];
  for (const artifact of Array.isArray(mission?.artifacts) ? mission.artifacts : []) {
    if (artifact.version !== mission.version) continue;
    const metadata = asRecord(artifact.metadata);
    if (metadata.kind === 'evidence') {
      evidence.push({
        id: boundedText(metadata.id, 180) || artifact.artifactKey,
        label: boundedText(metadata.label, 160) || artifact.name,
        detail: boundedText(metadata.detail, 900) || 'Evidencia registrada.',
        kind: boundedText(metadata.evidenceKind, 60) || 'verification',
        passed: typeof metadata.passed === 'boolean' ? metadata.passed : null,
      });
      continue;
    }
    deliverables.push({
      id: boundedText(metadata.id, 180) || artifact.artifactKey,
      name: boundedText(metadata.name, 180) || artifact.name,
      type: boundedText(metadata.type, 60) || artifact.type,
      ref: boundedText(metadata.ref, 500) || artifact.storageRef || artifact.sourceRef || null,
      status: artifact.status === 'verified' ? 'verified' : 'recorded',
    });
  }
  return normalizeMissionRecord({
    id: mission.id,
    missionId: mission.missionKey,
    missionTitle: mission.title,
    objective: mission.objective,
    department: mission.department,
    status: mission.status,
    summary: mission.summary,
    author: mission.author,
    runId: boundedText(asRecord(mission.metadata).runId, 180) || null,
    source: mission.source,
    sourceRef: mission.sourceRef,
    version: mission.version,
    contentHash: mission.contentHash,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
    deliverables,
    evidence,
    ceoReview: latestApprovalFor(mission, mission.approvals),
  });
}

function dbReportToReport(report) {
  return normalizeActivityReport({
    id: report.id,
    title: report.title,
    summary: report.summary,
    author: report.author,
    source: report.source,
    sourceRef: report.reportKey,
    version: report.version,
    contentHash: report.contentHash,
    createdAt: report.createdAt,
    period: {
      from: report.periodFrom,
      to: report.periodTo,
    },
    counts: report.counts,
    status: report.status,
    delivery: report.delivery,
  });
}

async function withTransaction(prisma, operation) {
  if (typeof prisma?.$transaction === 'function') {
    return prisma.$transaction((transaction) => operation(transaction));
  }
  return operation(prisma);
}

async function persistMissionRecord({ prisma, project, record }) {
  const normalized = normalizeMissionRecord(record);
  if (!normalized) return null;
  normalized.source = boundedText(record.source, 80) || 'progress_ledger';
  normalized.sourceRef = boundedText(record.sourceRef, 220)
    || (normalized.runId ? `run:${normalized.runId}` : normalized.id);
  const hash = contentHash(missionHashPayload(normalized));

  return withTransaction(prisma, async (tx) => {
    const existing = await tx.codexMission.findFirst({
      where: {
        projectId: project.id,
        userId: project.userId,
        sourceRef: normalized.sourceRef,
      },
    });
    const version = existing && existing.contentHash !== hash
      ? existing.version + 1
      : existing?.version || 1;
    const data = {
      projectId: project.id,
      userId: project.userId,
      missionKey: normalized.missionId,
      title: normalized.missionTitle,
      department: normalized.department,
      objective: normalized.objective,
      status: normalized.status,
      source: normalized.source,
      sourceRef: normalized.sourceRef,
      version,
      contentHash: hash,
      summary: normalized.summary,
      author: normalized.author,
      startedAt: new Date(normalized.createdAt),
      completedAt: new Date(normalized.updatedAt),
      metadata: {
        runId: normalized.runId,
        importedFromLegacyBrief: normalized.source === 'project_brief_migration',
      },
    };
    const mission = existing
      ? await tx.codexMission.update({ where: { id: existing.id }, data })
      : await tx.codexMission.create({
        data: {
          ...data,
          createdAt: new Date(normalized.createdAt),
        },
      });

    for (const artifact of artifactRowsFromRecord(normalized, version)) {
      await tx.codexMissionArtifact.upsert({
        where: {
          missionId_artifactKey_version: {
            missionId: mission.id,
            artifactKey: artifact.artifactKey,
            version,
          },
        },
        create: {
          ...artifact,
          missionId: mission.id,
          projectId: project.id,
          userId: project.userId,
        },
        update: artifact,
      });
    }
    return mission;
  });
}

async function persistLegacyActivityReport({ prisma, project, report }) {
  const normalized = normalizeActivityReport(report);
  if (!normalized) return null;
  const reportKey = `legacy:${normalized.id}`.slice(0, 220);
  const existing = await prisma.codexActivityReport.findFirst({
    where: {
      projectId: project.id,
      userId: project.userId,
      reportKey,
      version: normalized.version,
    },
  });
  if (existing) return existing;
  const payload = {
    reportKey,
    title: normalized.title,
    summary: normalized.summary,
    status: normalized.status,
    source: 'project_brief_migration',
    version: normalized.version,
    period: normalized.period,
    counts: normalized.counts,
    delivery: normalized.delivery,
    author: normalized.author,
  };
  return prisma.codexActivityReport.create({
    data: {
      projectId: project.id,
      userId: project.userId,
      reportKey,
      title: payload.title,
      summary: payload.summary,
      status: payload.status,
      source: payload.source,
      version: payload.version,
      contentHash: contentHash(payload),
      periodFrom: new Date(normalized.period.from),
      periodTo: new Date(normalized.period.to),
      counts: normalized.counts,
      delivery: normalized.delivery,
      author: normalized.author,
      createdAt: new Date(normalized.createdAt),
    },
  });
}

async function readDurableStore({ prisma, project }) {
  const [missions, reports] = await Promise.all([
    prisma.codexMission.findMany({
      where: { projectId: project.id, userId: project.userId },
      orderBy: { createdAt: 'desc' },
      take: MAX_MISSION_RECORDS,
      include: {
        artifacts: { orderBy: [{ version: 'desc' }, { createdAt: 'asc' }] },
        approvals: { orderBy: { createdAt: 'desc' }, take: 20 },
      },
    }),
    prisma.codexActivityReport.findMany({
      where: { projectId: project.id, userId: project.userId },
      orderBy: { createdAt: 'desc' },
      take: MAX_ACTIVITY_REPORTS,
    }),
  ]);
  return normalizeStore({
    records: missions.map(dbMissionToRecord),
    reports: reports.map(dbReportToReport),
  });
}

async function syncMissionEvidence({ prisma, project }) {
  let snapshot = readMissionEvidence(project);
  if (!prisma?.codexProject || !project?.id) return summarizeStore(snapshot);
  if (durableModelsReady(prisma)) {
    const legacyRecords = snapshot.records.map((record) => ({
      ...record,
      source: record.source === 'project_brief_legacy' ? 'project_brief_migration' : record.source,
    }));
    const ledgerRecords = (Array.isArray(asRecord(project.brief).ledger)
      ? project.brief.ledger
      : [])
      .filter((entry) => entry?.runId)
      .map((entry) => ({
        ...recordFromProgressEntry(entry),
        source: 'progress_ledger',
        sourceRef: `run:${entry.runId}`,
      }));
    let durableStore = await readDurableStore({ prisma, project });
    let changed = false;
    const missionsBySourceRef = new Map(
      durableStore.records.map((record) => [record.sourceRef, record]),
    );
    for (const candidate of [...legacyRecords, ...ledgerRecords]) {
      const normalized = normalizeMissionRecord(candidate);
      if (!normalized) continue;
      normalized.source = boundedText(candidate.source, 80) || 'progress_ledger';
      normalized.sourceRef = boundedText(candidate.sourceRef, 220)
        || (normalized.runId ? `run:${normalized.runId}` : normalized.id);
      const existing = missionsBySourceRef.get(normalized.sourceRef);
      if (existing?.source === 'run_completion' && normalized.source !== 'run_completion') continue;
      if (existing?.contentHash === contentHash(missionHashPayload(normalized))) continue;
      await persistMissionRecord({ prisma, project, record: normalized });
      changed = true;
    }
    const reportKeys = new Set(durableStore.reports.map((report) => report.sourceRef));
    for (const report of snapshot.reports) {
      if (reportKeys.has(`legacy:${report.id}`.slice(0, 220))) continue;
      await persistLegacyActivityReport({ prisma, project, report });
      changed = true;
    }
    if (changed) durableStore = await readDurableStore({ prisma, project });
    snapshot = durableStore;
    return summarizeStore(snapshot);
  }
  await mutateProjectBrief({
    prisma,
    projectId: project.id,
    userId: project.userId,
    mutate: (brief) => {
      const current = normalizeStore(brief.missionEvidence);
      snapshot = mergeProgressRecords(current, Array.isArray(brief.ledger) ? brief.ledger : []);
      return { ...brief, missionEvidence: snapshot };
    },
  });
  return summarizeStore(snapshot);
}

async function recordMissionCompletion({
  prisma,
  project,
  runId,
  missionId = null,
  missionTitle,
  department,
  outcome,
  executiveSummary,
  acceptance = [],
  author = null,
  now = new Date(),
}) {
  if (!prisma?.codexProject || !project?.id || !runId) return null;
  const summary = asRecord(executiveSummary);
  const diffstat = asRecord(summary.diffstat);
  const entry = {
    missionId,
    department,
    task: missionTitle,
  };
  const record = normalizeMissionRecord({
    id: `run:${runId}`,
    missionId: inferMissionId(entry),
    missionTitle: missionTitleFor(entry),
    department,
    status: outcome === 'passed' ? 'completed' : 'blocked',
    summary: [summary.result, summary.impact].map((part) => boundedText(part, 1_000)).filter(Boolean).join(' '),
    author: author || `${boundedText(department, 120) || 'CEO Office'} · SiraGPT Agent`,
    runId,
    createdAt: now,
    updatedAt: now,
    deliverables: [
      {
        id: `report:${runId}`,
        name: 'Resumen ejecutivo de misión',
        type: 'report',
        ref: `run:${runId}`,
        status: 'verified',
      },
      ...(summary.checkpointSha ? [{
        id: `checkpoint:${summary.checkpointSha}`,
        name: 'Checkpoint Git verificado',
        type: 'checkpoint',
        ref: summary.checkpointSha,
        status: outcome === 'passed' ? 'verified' : 'recorded',
      }] : []),
      ...(Number(diffstat.filesChanged) > 0 ? [{
        id: `workspace:${runId}`,
        name: `${Number(diffstat.filesChanged)} archivo(s) actualizado(s)`,
        type: 'workspace_change',
        ref: `+${Math.max(0, Number(diffstat.additions) || 0)}/-${Math.max(0, Number(diffstat.deletions) || 0)}`,
        status: outcome === 'passed' ? 'verified' : 'recorded',
      }] : []),
    ],
    evidence: [
      ...(Array.isArray(summary.evidence) ? summary.evidence.map((detail, index) => ({
        id: `summary-${index + 1}`,
        label: 'Verificación',
        detail,
        kind: 'verification',
        passed: outcome === 'passed',
      })) : []),
      ...(Array.isArray(acceptance) ? acceptance.map((item, index) => ({
        id: `acceptance-${index + 1}`,
        label: boundedText(item?.criterion, 160) || 'Criterio de aceptación',
        detail: boundedText(item?.evidence, 900) || (item?.passed ? 'Criterio aprobado.' : 'Criterio pendiente.'),
        kind: 'acceptance',
        passed: item?.passed === true,
      })) : []),
    ],
    ceoReview: { status: 'pending' },
    source: 'run_completion',
    sourceRef: `run:${runId}`,
  });

  if (durableModelsReady(prisma)) {
    await persistMissionRecord({ prisma, project, record });
    const store = await readDurableStore({ prisma, project });
    return store.records.find((item) => item.sourceRef === `run:${runId}`) || null;
  }

  let stored = record;
  await mutateProjectBrief({
    prisma,
    projectId: project.id,
    userId: project.userId,
    mutate: (brief) => {
      const store = normalizeStore(brief.missionEvidence);
      const existing = store.records.find((item) => item.id === record.id);
      stored = {
        ...record,
        ...(existing || {}),
        deliverables: record.deliverables,
        evidence: record.evidence,
        summary: record.summary,
        status: record.status,
        updatedAt: record.updatedAt,
        ceoReview: normalizeReview(existing?.ceoReview),
      };
      const records = [
        ...store.records.filter((item) => item.id !== record.id),
        stored,
      ].slice(-MAX_MISSION_RECORDS);
      return {
        ...brief,
        missionEvidence: { ...store, records },
      };
    },
  });
  return stored;
}

function serviceError(code, status, message) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

async function reviewMissionRecord({
  prisma,
  project,
  recordId,
  status,
  note = null,
  reviewer = 'CEO Office',
  now = new Date(),
}) {
  if (!REVIEW_STATUSES.has(status)) {
    throw serviceError('mission_review_status_invalid', 400, 'Estado de revisión no válido.');
  }
  if (durableModelsReady(prisma)) {
    const mission = await prisma.codexMission.findFirst({
      where: {
        id: recordId,
        projectId: project.id,
        userId: project.userId,
      },
      include: {
        artifacts: { orderBy: [{ version: 'desc' }, { createdAt: 'asc' }] },
        approvals: { orderBy: { createdAt: 'desc' }, take: 20 },
      },
    });
    if (!mission) {
      throw serviceError('mission_record_not_found', 404, 'Entregable de misión no encontrado.');
    }
    await prisma.codexCeoApproval.create({
      data: {
        projectId: project.id,
        userId: project.userId,
        missionId: mission.id,
        resourceType: 'mission',
        resourceId: mission.id,
        decision: status,
        note: boundedText(note, 1_000) || null,
        reviewerName: boundedText(reviewer, 120) || 'CEO Office',
        resourceHash: mission.contentHash,
        createdAt: now,
      },
    });
    const refreshed = await prisma.codexMission.findFirst({
      where: {
        id: recordId,
        projectId: project.id,
        userId: project.userId,
      },
      include: {
        artifacts: { orderBy: [{ version: 'desc' }, { createdAt: 'asc' }] },
        approvals: { orderBy: { createdAt: 'desc' }, take: 20 },
      },
    });
    return dbMissionToRecord(refreshed);
  }
  let updated = null;
  await mutateProjectBrief({
    prisma,
    projectId: project.id,
    userId: project.userId,
    mutate: (brief) => {
      const store = mergeProgressRecords(
        normalizeStore(brief.missionEvidence),
        Array.isArray(brief.ledger) ? brief.ledger : [],
      );
      const existing = store.records.find((record) => record.id === recordId);
      if (!existing) throw serviceError('mission_record_not_found', 404, 'Entregable de misión no encontrado.');
      updated = {
        ...existing,
        updatedAt: now.toISOString(),
        ceoReview: normalizeReview({
          status,
          reviewedAt: status === 'pending' ? null : now,
          reviewedBy: status === 'pending' ? null : reviewer,
          note,
        }),
      };
      return {
        ...brief,
        missionEvidence: {
          ...store,
          records: store.records.map((record) => (record.id === recordId ? updated : record)),
        },
      };
    },
  });
  return updated;
}

function buildActivitySummary(records, period) {
  const completed = records.filter((record) => record.status === 'completed').length;
  const blocked = records.filter((record) => record.status === 'blocked').length;
  const approved = records.filter((record) => record.ceoReview.status === 'approved').length;
  const pending = records.filter((record) => record.ceoReview.status === 'pending').length;
  const lines = [
    `Periodo: ${period.from.slice(0, 10)} a ${period.to.slice(0, 10)}.`,
    `${records.length} misión(es) registradas: ${completed} completadas, ${blocked} bloqueadas.`,
    `Revisión CEO: ${approved} aprobadas, ${pending} pendientes.`,
  ];
  for (const record of records.slice(0, 8)) {
    lines.push(
      `- ${record.department}: ${record.missionTitle} [${record.status}; CEO ${record.ceoReview.status}]`,
    );
  }
  if (!records.length) lines.push('- No se registró actividad verificable durante el periodo.');
  return lines.join('\n');
}

function reportDelivery({
  requestEmail,
  confirmEmailQueue,
  companyContext,
  now,
}) {
  if (!requestEmail) {
    return normalizeDelivery({
      status: 'not_requested',
      reason: 'El reporte se conserva como borrador; no se solicitó entrega por correo.',
    });
  }
  const connected = companyContext?.readiness?.evidence?.gmailConnected === true;
  const mode = companyContext?.safeguards?.emailReplies || 'review';
  if (!connected) {
    return normalizeDelivery({
      status: 'blocked_connection',
      connectionReady: false,
      permissionGranted: false,
      permissionMode: mode,
      reason: 'Conecta Gmail antes de poner el reporte en cola.',
    });
  }
  if (mode === 'off') {
    return normalizeDelivery({
      status: 'blocked_policy',
      connectionReady: true,
      permissionGranted: false,
      permissionMode: mode,
      reason: 'La política de correo está desactivada.',
    });
  }
  if (confirmEmailQueue !== true) {
    return normalizeDelivery({
      status: 'pending_permission',
      connectionReady: true,
      permissionGranted: false,
      permissionMode: mode,
      reason: 'Falta la confirmación explícita para poner el reporte en cola.',
    });
  }
  return normalizeDelivery({
    status: 'queued',
    connectionReady: true,
    permissionGranted: true,
    permissionMode: mode,
    queuedAt: now,
    reason: 'En cola para un dispatcher de correo auditado; este servicio no envía mensajes.',
  });
}

async function createActivityReport({
  prisma,
  project,
  companyContext,
  days = 7,
  requestEmail = false,
  confirmEmailQueue = false,
  now = new Date(),
}) {
  const boundedDays = Math.max(1, Math.min(30, Number.parseInt(days, 10) || 7));
  const period = {
    from: new Date(now.getTime() - boundedDays * 24 * 60 * 60 * 1_000).toISOString(),
    to: now.toISOString(),
  };
  if (durableModelsReady(prisma)) {
    const store = await readDurableStore({ prisma, project });
    const records = store.records
      .filter((record) => record.createdAt >= period.from && record.createdAt <= period.to)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const delivery = reportDelivery({
      requestEmail,
      confirmEmailQueue,
      companyContext,
      now,
    });
    const counts = {
      missions: records.length,
      completed: records.filter((record) => record.status === 'completed').length,
      blocked: records.filter((record) => record.status === 'blocked').length,
      pendingReview: records.filter((record) => record.ceoReview.status === 'pending').length,
      approved: records.filter((record) => record.ceoReview.status === 'approved').length,
    };
    const reportKey = crypto.randomUUID();
    const payload = {
      reportKey,
      title: `Resumen de actividad · ${period.to.slice(0, 10)}`,
      summary: buildActivitySummary(records, period),
      author: 'CEO Office',
      source: 'mission_evidence',
      version: 1,
      period,
      counts,
      status: delivery.status === 'queued' ? 'queued' : 'draft',
      delivery,
    };
    const created = await prisma.codexActivityReport.create({
      data: {
        projectId: project.id,
        userId: project.userId,
        reportKey,
        title: payload.title,
        summary: payload.summary,
        status: payload.status,
        source: payload.source,
        version: payload.version,
        contentHash: contentHash(payload),
        periodFrom: new Date(period.from),
        periodTo: new Date(period.to),
        counts,
        delivery,
        author: payload.author,
        createdAt: now,
      },
    });
    return dbReportToReport(created);
  }
  let created = null;
  await mutateProjectBrief({
    prisma,
    projectId: project.id,
    userId: project.userId,
    mutate: (brief) => {
      const store = mergeProgressRecords(
        normalizeStore(brief.missionEvidence),
        Array.isArray(brief.ledger) ? brief.ledger : [],
      );
      const records = store.records
        .filter((record) => record.createdAt >= period.from && record.createdAt <= period.to)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      const delivery = reportDelivery({
        requestEmail,
        confirmEmailQueue,
        companyContext,
        now,
      });
      created = normalizeActivityReport({
        id: `activity:${crypto.randomUUID()}`,
        title: `Resumen de actividad · ${period.to.slice(0, 10)}`,
        summary: buildActivitySummary(records, period),
        author: 'CEO Office',
        createdAt: now,
        period,
        counts: {
          missions: records.length,
          completed: records.filter((record) => record.status === 'completed').length,
          blocked: records.filter((record) => record.status === 'blocked').length,
          pendingReview: records.filter((record) => record.ceoReview.status === 'pending').length,
          approved: records.filter((record) => record.ceoReview.status === 'approved').length,
        },
        status: delivery.status === 'queued' ? 'queued' : 'draft',
        delivery,
      });
      return {
        ...brief,
        missionEvidence: {
          ...store,
          reports: [...store.reports, created].slice(-MAX_ACTIVITY_REPORTS),
        },
      };
    },
  });
  return created;
}

module.exports = {
  DELIVERY_STATUSES,
  LEDGER_VERSION,
  MAX_ACTIVITY_REPORTS,
  MAX_MISSION_RECORDS,
  REVIEW_STATUSES,
  buildActivitySummary,
  contentHash,
  createActivityReport,
  dbMissionToRecord,
  durableModelsReady,
  inferMissionId,
  mergeProgressRecords,
  normalizeActivityReport,
  normalizeMissionRecord,
  normalizeStore,
  readMissionEvidence,
  readDurableStore,
  recordFromProgressEntry,
  recordMissionCompletion,
  reportDelivery,
  reviewMissionRecord,
  persistMissionRecord,
  summarizeStore,
  syncMissionEvidence,
};
