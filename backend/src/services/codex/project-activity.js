'use strict';

const MAX_EVENTS = 200;
const DEFAULT_EVENTS = 80;
const SAFE_EVENT_TYPES = Object.freeze([
  'run_status',
  'plan_proposed',
  'plan_updated',
  'reasoning_start',
  'reasoning_end',
  'action_start',
  'action_end',
  'budget_status',
  'checkpoint_created',
  'run_summary',
  'action_required',
  'tool_permission_required',
  'tool_permission_resolved',
]);

const SECRET_PATTERN = /((?:api[_-]?key|authorization|bearer|password|passwd|secret|token|cookie|private[_-]?key))\s*[:=]\s*[^\s,;]+/gi;

function text(value, max = 240) {
  return String(value || '')
    .replace(SECRET_PATTERN, '$1=[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function departmentFromPrompt(prompt) {
  const match = /^\s*\[(?:PROACTIVO|SWARM)\s*·\s*([^\]]+)\]/i.exec(String(prompt || ''));
  return text(match?.[1] || 'CEO Office', 80);
}

function metricsDetail(metrics) {
  const source = metrics && typeof metrics === 'object' ? metrics : {};
  const additions = Math.max(0, Number(source.additions) || 0);
  const deletions = Math.max(0, Number(source.deletions) || 0);
  const actions = Math.max(0, Number(source.actionsCount) || 0);
  return `${actions} acciones · +${additions}/-${deletions}`;
}

function projectActivityEvent(event) {
  const data = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  const base = {
    id: event?.id,
    runId: event?.run?.id || event?.runId,
    seq: Number(event?.seq) || 0,
    type: event?.type,
    department: departmentFromPrompt(event?.run?.prompt),
    createdAt: event?.createdAt instanceof Date
      ? event.createdAt.toISOString()
      : String(event?.createdAt || ''),
  };

  switch (event?.type) {
    case 'run_status':
      return { ...base, tone: data.status === 'error' ? 'error' : data.status === 'done' ? 'success' : 'active', title: `Run ${text(data.status, 40)}`, detail: text(event?.run?.prompt, 180) };
    case 'plan_proposed':
      return { ...base, tone: 'info', title: 'Plan preparado', detail: text(data.architecture, 220) };
    case 'plan_updated': {
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      const completed = tasks.filter((task) => task?.status === 'completed').length;
      return { ...base, tone: 'active', title: 'Checklist actualizado', detail: `${completed}/${tasks.length} tareas completadas` };
    }
    case 'reasoning_start':
      return { ...base, tone: 'active', title: text(data.label, 120) || 'Analizando', detail: 'Razonamiento en curso' };
    case 'reasoning_end':
      return { ...base, tone: 'info', title: 'Análisis completado', detail: `${Math.max(0, Number(data.durationMs) || 0)} ms` };
    case 'action_start':
      return {
        ...base,
        tone: 'active',
        title: data.kind === 'file_write' ? 'Modificando código' : `Ejecutando ${text(data.kind, 40)}`,
        detail: text(data.path || data.command || 'Acción iniciada', 220),
      };
    case 'action_end':
      return {
        ...base,
        tone: data.status === 'error' ? 'error' : 'success',
        title: data.status === 'error' ? 'Acción con error' : 'Acción completada',
        detail: text(data.outputSummary, 220),
      };
    case 'budget_status':
      return {
        ...base,
        tone: data.allowed ? 'info' : 'error',
        title: data.allowed ? 'Presupuesto disponible' : 'Presupuesto detenido',
        detail: text(data.reason, 160),
      };
    case 'checkpoint_created':
      return { ...base, tone: 'success', title: 'Checkpoint creado', detail: `${text(data.title, 140)} · ${text(data.commitSha, 12)}` };
    case 'run_summary':
      return { ...base, tone: 'success', title: 'Resumen verificado', detail: metricsDetail(data.metrics) };
    case 'action_required':
      return { ...base, tone: 'error', title: text(data.title, 140) || 'Acción requerida', detail: text(data.rawError, 220) };
    case 'tool_permission_required':
      return { ...base, tone: 'attention', title: 'Aprobación requerida', detail: text(data.humanDescription || data.toolName, 220) };
    case 'tool_permission_resolved':
      return { ...base, tone: data.decision === 'allow' ? 'success' : 'info', title: 'Aprobación resuelta', detail: `${text(data.toolName, 100)} · ${text(data.decision, 20)}` };
    default:
      return null;
  }
}

function normalizeLimit(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(MAX_EVENTS, parsed)) : DEFAULT_EVENTS;
}

async function listProjectActivity({
  prisma,
  projectId,
  limit = DEFAULT_EVENTS,
}) {
  if (!prisma?.codexEvent?.findMany) throw new Error('codex event store unavailable');
  const rows = await prisma.codexEvent.findMany({
    where: {
      type: { in: SAFE_EVENT_TYPES },
      run: { projectId },
    },
    orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }],
    take: normalizeLimit(limit),
    select: {
      id: true,
      runId: true,
      seq: true,
      type: true,
      payload: true,
      createdAt: true,
      run: {
        select: {
          id: true,
          prompt: true,
          status: true,
        },
      },
    },
  });
  return rows.map(projectActivityEvent).filter(Boolean);
}

module.exports = {
  DEFAULT_EVENTS,
  MAX_EVENTS,
  SAFE_EVENT_TYPES,
  departmentFromPrompt,
  listProjectActivity,
  normalizeLimit,
  projectActivityEvent,
};
