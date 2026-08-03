'use strict';

const {
  buildCompanyAutopilotPlan,
} = require('./company-autopilot-planner');
const {
  CodexSwarmOrchestrator,
  SWARM_STATUSES,
  TASK_STATUSES,
  aggregateTaskProgress,
} = require('./swarm-orchestrator');
const {
  listProjectActivity,
} = require('./project-activity');
const {
  loadCompanyOperatingContext,
} = require('./company-operating-profile');
const {
  WORKSTREAM_DEPARTMENTS,
  projectedEnterpriseDepartmentId,
} = require('./enterprise-departments');

const ACTIVE_SWARM_STATUSES = new Set([
  SWARM_STATUSES.QUEUED,
  SWARM_STATUSES.RUNNING,
  SWARM_STATUSES.PAUSED,
  SWARM_STATUSES.CANCELLING,
]);

const DEPARTMENT_NAMES = Object.freeze({
  'ceo-office': 'CEO Office',
  'product-engineering': 'Producto e Ingeniería',
  marketing: 'Marketing',
  'customer-success': 'Customer Success',
  'sales-operations': 'Ventas y Revenue Operations',
  trust: 'Confianza, Privacidad y Cumplimiento',
  'trust-quality': 'Confianza, Privacidad y Cumplimiento',
});

const SECRET_PATTERN = /((?:api[_-]?key|authorization|bearer|password|passwd|secret|token|cookie|private[_-]?key))\s*[:=]\s*[^\s,;]+/gi;

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value, max = 500) {
  return String(value || '')
    .replace(SECRET_PATTERN, '$1=[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function iso(value, fallback = new Date()) {
  const date = value instanceof Date ? value : new Date(value || fallback);
  return Number.isNaN(date.getTime()) ? fallback.toISOString() : date.toISOString();
}

function optionalIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function plannerInputFromCompany(company) {
  const context = record(company);
  const profile = record(context.profile);
  const readiness = record(context.readiness);
  const evidence = record(readiness.evidence);
  const autonomy = record(profile.autonomy);
  const socialConnections = Array.isArray(evidence.socialConnections)
    ? evidence.socialConnections
    : [];
  const publishedUrl = text(evidence.publishedUrl || profile.websiteUrl, 500);

  return {
    companyOperatingProfile: {
      ...profile,
      software: { exists: evidence.workspaceReady === true },
      website: { exists: Boolean(publishedUrl), url: publishedUrl || null },
      social: {
        connected: socialConnections.length > 0,
        accounts: socialConnections,
      },
      inbox: {
        connected: evidence.gmailConnected === true,
        processReady: Boolean(profile.customerServiceProcess),
      },
      idealCustomerProfile: profile.targetCustomer || null,
      sales: {
        pipelineReady: Boolean(profile.salesProcess),
      },
      connections: {
        deployment: Boolean(publishedUrl),
        social: socialConnections.length > 0,
        inbox: evidence.gmailConnected === true,
        sales: Boolean(profile.salesProcess),
      },
      automationPolicies: {
        social: {
          publish: autonomy.socialPublishing === 'auto',
          respond: autonomy.socialReplies === 'auto',
        },
        inbox: {
          respond: autonomy.emailReplies === 'auto',
        },
        sales: {
          contactLeads: autonomy.leadOutreach === 'auto',
        },
      },
    },
    readiness: {
      mission: Boolean(profile.mission),
      vision: Boolean(profile.vision),
      software: evidence.workspaceReady === true,
      website: Boolean(publishedUrl),
      socialPresence: socialConnections.length > 0,
      inboxProcess: evidence.gmailConnected === true,
      idealCustomerProfile: Boolean(profile.targetCustomer),
      salesPipeline: Boolean(profile.salesProcess),
    },
  };
}

function runState(status) {
  switch (status) {
    case SWARM_STATUSES.QUEUED:
      return 'queued';
    case SWARM_STATUSES.RUNNING:
      return 'running';
    case SWARM_STATUSES.CANCELLING:
      return 'cancelling';
    case SWARM_STATUSES.PAUSED:
      return 'paused';
    case SWARM_STATUSES.COMPLETED:
      return 'completed';
    case SWARM_STATUSES.COMPLETED_WITH_ERRORS:
      return 'completed_with_errors';
    case SWARM_STATUSES.CANCELLED:
      return 'cancelled';
    case SWARM_STATUSES.FAILED:
      return 'failed';
    default:
      return 'idle';
  }
}

function readinessState(company) {
  const source = record(company?.readiness);
  const areas = Array.isArray(source.areas) ? source.areas : [];
  if (areas.some((area) => area?.status === 'blocked')) return 'blocked';
  return Number(source.score) >= 100 ? 'ready' : 'attention';
}

function readinessProjection(company, swarm) {
  const source = record(company?.readiness);
  const areas = Array.isArray(source.areas) ? source.areas : [];
  return {
    status: readinessState(company),
    score: Math.max(0, Math.min(100, Number(source.score) || 0)),
    runState: runState(swarm?.status),
    checks: areas.map((area) => ({
      id: text(area?.id, 80),
      label: text(area?.label, 160),
      status: area?.status === 'ready'
        ? 'ready'
        : area?.status === 'blocked'
          ? 'blocked'
          : 'attention',
      detail: text(area?.evidence || area?.action, 320),
    })),
    lastCheckedAt: optionalIso(swarm?.updatedAt || company?.profile?.updatedAt),
  };
}

function taskDepartmentId(inputValue) {
  const input = record(inputValue);
  const explicitDepartmentId = input.departmentId
    ? projectedEnterpriseDepartmentId(input.departmentId)
    : '';
  if (explicitDepartmentId) return explicitDepartmentId;
  const workstreamId = text(input.workstreamId, 80);
  return projectedEnterpriseDepartmentId(
    WORKSTREAM_DEPARTMENTS[workstreamId] || workstreamId || 'product-engineering',
  );
}

function tasksForWorkstream(tasks, workstreamId) {
  const departmentId = projectedEnterpriseDepartmentId(
    WORKSTREAM_DEPARTMENTS[workstreamId] || workstreamId,
  );
  return tasks.filter((task) => {
    const input = record(task.input);
    // A durable department assignment is authoritative. Falling back to the
    // planner workstream is only valid when no department has been persisted.
    if (text(input.departmentId, 80)) return taskDepartmentId(input) === departmentId;
    return text(input.workstreamId, 80) === workstreamId || taskDepartmentId(input) === departmentId;
  });
}

function latestTask(tasks) {
  return tasks.reduce((latest, task) => {
    if (!latest) return task;
    const latestAt = new Date(latest.updatedAt || 0).getTime();
    const taskAt = new Date(task.updatedAt || 0).getTime();
    return taskAt >= latestAt ? task : latest;
  }, null);
}

function departmentStatus(swarm, tasks) {
  if (!tasks.length) return 'planned';
  if (tasks.some((task) => task.status === TASK_STATUSES.RUNNING)) return 'active';
  if (swarm?.status === SWARM_STATUSES.CANCELLING) return 'cancelling';
  if (swarm?.status === SWARM_STATUSES.PAUSED) return 'paused';
  if (tasks.some((task) => task.status === TASK_STATUSES.FAILED)) return 'failed';
  if (tasks.some((task) => task.status === TASK_STATUSES.BLOCKED)) return 'blocked';
  if (tasks.length && tasks.every((task) => task.status === TASK_STATUSES.SUCCEEDED)) return 'completed';
  if (tasks.every((task) => (
    task.status === TASK_STATUSES.SUCCEEDED || task.status === TASK_STATUSES.CANCELLED
  ))) return 'cancelled';
  return 'queued';
}

function departmentProjection(plan, swarmProgress) {
  const tasks = Array.isArray(swarmProgress?.tasks) ? swarmProgress.tasks : [];
  const swarm = swarmProgress?.swarm || null;
  return plan.workstreams.map((workstream) => {
    const workstreamTasks = tasksForWorkstream(tasks, workstream.id);
    const logicalTasks = workstreamTasks.length;
    const plannedTasks = workstreamTasks.length ? 0 : workstream.tasks.length;
    const completedTasks = workstreamTasks.filter((task) => task.status === TASK_STATUSES.SUCCEEDED).length;
    const activeAgents = workstreamTasks.filter((task) => task.status === TASK_STATUSES.RUNNING).length;
    const queuedTasks = workstreamTasks.filter((task) => task.status === TASK_STATUSES.QUEUED).length;
    const blockedTasks = workstreamTasks.filter((task) => task.status === TASK_STATUSES.BLOCKED).length;
    const failedTasks = workstreamTasks.filter((task) => task.status === TASK_STATUSES.FAILED).length;
    const cancelledTasks = workstreamTasks.filter((task) => task.status === TASK_STATUSES.CANCELLED).length;
    const latest = latestTask(workstreamTasks);
    const current = latestTask(workstreamTasks.filter((task) => task.status === TASK_STATUSES.RUNNING))
      || latestTask(workstreamTasks.filter((task) => task.status === TASK_STATUSES.QUEUED))
      || latestTask(workstreamTasks.filter((task) => task.status === TASK_STATUSES.BLOCKED))
      || latestTask(workstreamTasks.filter((task) => task.status === TASK_STATUSES.FAILED))
      || latest;
    return {
      id: WORKSTREAM_DEPARTMENTS[workstream.id] || workstream.id,
      workstreamId: workstream.id,
      name: text(workstream.departmentLabel || workstream.title, 160),
      objective: text(workstream.rationale || workstream.title, 360),
      status: departmentStatus(swarm, workstreamTasks),
      logicalAgents: logicalTasks,
      plannedTasks,
      activeAgents,
      queuedTasks,
      blockedTasks,
      failedTasks,
      cancelledTasks,
      completedTasks,
      progress: logicalTasks ? Math.round((completedTasks / logicalTasks) * 100) : 0,
      currentWork: current ? text(current.title, 240) : null,
      owner: 'CEO Office',
      lastUpdatedAt: optionalIso(latest?.updatedAt),
    };
  });
}

function taskEvent(task, swarm) {
  const input = record(task.input);
  const departmentId = taskDepartmentId(input);
  const status = task.status === TASK_STATUSES.SUCCEEDED
    ? 'completed'
    : task.status;
  const kind = task.role === 'integrator'
    ? 'coding'
    : task.role === 'reviewer'
      ? 'verification'
      : 'research';
  const result = record(task.result);
  return {
    id: `swarm-task:${task.id}`,
    timestamp: iso(task.updatedAt || swarm?.updatedAt),
    title: text(task.title, 180),
    kind,
    status,
    detail: text(result.summary || task.error || input.instruction, 300),
    departmentId,
    departmentName: text(
      input.departmentName || input.workstreamTitle || DEPARTMENT_NAMES[departmentId] || departmentId,
      120,
    ),
  };
}

function activityEvent(event) {
  const tone = String(event?.tone || '');
  return {
    id: `run-event:${text(event?.id, 160)}`,
    timestamp: iso(event?.createdAt),
    title: text(event?.title, 180),
    kind: tone === 'error'
      ? 'error'
      : /código|modificando/i.test(String(event?.title || ''))
        ? 'coding'
        : /verific|checkpoint|resumen/i.test(String(event?.title || ''))
          ? 'verification'
          : 'delivery',
    status: tone === 'error' || tone === 'attention'
      ? 'blocked'
      : tone === 'active'
        ? 'running'
        : 'completed',
    detail: text(event?.detail, 300),
    departmentName: text(event?.department || 'CEO Office', 120),
  };
}

function executiveSummary(plan, swarmProgress) {
  const swarm = swarmProgress?.swarm || null;
  const progress = swarmProgress?.progress || aggregateTaskProgress(swarmProgress?.tasks || []);
  const failures = Number(progress?.counts?.failed) || 0;
  const approvals = Array.isArray(plan.approvalQueue) ? plan.approvalQueue.length : 0;
  return {
    title: 'Informe del CEO Office',
    summary: text(plan.executiveSummary, 800),
    updatedAt: optionalIso(swarm?.updatedAt),
    highlights: [
      `${Number(progress?.counts?.succeeded) || 0} tareas verificadas`,
      `${plan.workstreams.length} frentes empresariales coordinados`,
    ],
    risks: [
      ...(failures ? [`${failures} tareas necesitan corrección`] : []),
      ...(approvals ? [`${approvals} acciones externas esperan aprobación o conexión real`] : []),
    ],
    nextActions: plan.priorities.slice(0, 3).map((priority) => (
      text(plan.workstreams.find((item) => item.id === priority.workstreamId)?.title, 180)
    )).filter(Boolean),
  };
}

function buildEnterpriseCommandCenter({
  company,
  plan,
  swarmProgress = null,
  activity = [],
} = {}) {
  const profile = record(company?.profile);
  const swarm = swarmProgress?.swarm || null;
  const tasks = Array.isArray(swarmProgress?.tasks) ? swarmProgress.tasks : [];
  const progress = swarmProgress?.progress || aggregateTaskProgress(tasks);
  const taskEvents = tasks
    .filter((task) => task.status !== TASK_STATUSES.QUEUED)
    .map((task) => taskEvent(task, swarm));
  const liveEvents = [...taskEvents, ...activity.map(activityEvent)]
    .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
    .slice(0, 80);
  const departments = departmentProjection(plan, swarmProgress);

  return {
    readiness: readinessProjection(company, swarm),
    mission: text(profile.mission, 600) || 'Definir una misión basada en evidencia del mercado y del cliente.',
    vision: text(profile.vision, 600) || 'Construir una operación medible, autónoma y supervisable.',
    swarmSummary: {
      logicalAgents: Number(progress?.counts?.total) || 0,
      planned: departments.reduce((total, department) => total + department.plannedTasks, 0),
      active: Number(progress?.counts?.running) || 0,
      queued: Number(progress?.counts?.queued) || 0,
      blocked: Number(progress?.counts?.blocked) || 0,
      completed: Number(progress?.counts?.succeeded) || 0,
      failed: Number(progress?.counts?.failed) || 0,
      cancelled: Number(progress?.counts?.cancelled) || 0,
      maxParallel: Number(swarm?.maxConcurrency) || 0,
    },
    departments,
    liveEvents,
    executiveSummary: executiveSummary(plan, swarmProgress),
    swarm: swarm ? {
      id: swarm.id,
      name: text(swarm.name, 300),
      status: swarm.status,
      progressPercent: Number(swarm.progressPercent) || 0,
      maxConcurrency: Number(swarm.maxConcurrency) || 0,
      totalTaskCount: Number(swarm.totalTaskCount) || 0,
      updatedAt: iso(swarm.updatedAt),
    } : null,
    governance: plan.governance,
  };
}

async function loadLatestSwarmProgress({ prisma, projectId, userId }) {
  if (!prisma?.codexSwarm?.findFirst) return null;
  const latest = await prisma.codexSwarm.findFirst({
    where: { projectId, userId },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (!latest) return null;
  return new CodexSwarmOrchestrator({ prisma }).getProgress(latest.id);
}

async function loadEnterpriseCommandCenter({
  prisma,
  project,
} = {}) {
  if (!project?.id || !project?.userId) throw new Error('enterprise_command_center_project_required');
  const [company, swarmProgress, activity] = await Promise.all([
    loadCompanyOperatingContext({ prisma, project }),
    loadLatestSwarmProgress({
      prisma,
      projectId: project.id,
      userId: project.userId,
    }),
    listProjectActivity({
      prisma,
      projectId: project.id,
      limit: 80,
    }).catch(() => []),
  ]);
  const plan = buildCompanyAutopilotPlan(plannerInputFromCompany(company));
  return {
    company,
    plan,
    swarmProgress,
    commandCenter: buildEnterpriseCommandCenter({
      company,
      plan,
      swarmProgress,
      activity,
    }),
  };
}

module.exports = {
  ACTIVE_SWARM_STATUSES,
  WORKSTREAM_DEPARTMENTS,
  activityEvent,
  buildEnterpriseCommandCenter,
  departmentProjection,
  loadEnterpriseCommandCenter,
  loadLatestSwarmProgress,
  plannerInputFromCompany,
  readinessProjection,
  taskEvent,
};
