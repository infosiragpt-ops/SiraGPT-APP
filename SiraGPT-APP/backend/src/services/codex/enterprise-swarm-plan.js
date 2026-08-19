'use strict';

const MAX_LOGICAL_TASKS = 10_000;
const DEFAULT_LOGICAL_TASKS = 128;

const AUDIT_PERSPECTIVES = Object.freeze([
  'arquitectura y límites de módulos',
  'correctitud funcional y casos borde',
  'experiencia de usuario y accesibilidad',
  'rendimiento de frontend y backend',
  'seguridad, permisos y secretos',
  'datos, migraciones e integridad',
  'observabilidad y recuperación de errores',
  'pruebas, fixtures y regresiones',
  'API, contratos e integraciones',
  'producto, conversión y propuesta de valor',
  'SEO, contenido y distribución',
  'ventas, CRM y trazabilidad comercial',
  'correo, soporte y experiencia del cliente',
  'internacionalización y adaptación cultural',
  'coste, capacidad y uso de proveedores',
  'documentación y mantenibilidad',
]);

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function slug(value) {
  return String(value || 'task')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || 'task';
}

function specialistFor(workstream, task) {
  if (task.kind === 'external_effect') return 'planner';
  if (/mission|sales|social|inbox/i.test(workstream.id)) return 'enterprise_analyst';
  if (task.kind === 'draft') return 'planner';
  return 'explorer';
}

function taskInstruction({ objective, workstream, task }) {
  const externalRule = task.kind === 'external_effect'
    ? 'Prepara únicamente la propuesta, requisitos, aprobación y evidencia esperada. No ejecutes el efecto externo.'
    : 'Investiga y produce evidencia concreta; no modifiques archivos.';
  return [
    `Objetivo global: ${objective}`,
    `Área: ${workstream.title}.`,
    `Encargo: ${task.title}.`,
    `Salida esperada: ${task.output || 'informe verificable'}.`,
    externalRule,
  ].join('\n');
}

function buildEnterpriseSwarmTasks({
  plan,
  objective,
  logicalTasks = DEFAULT_LOGICAL_TASKS,
} = {}) {
  if (!plan || !Array.isArray(plan.workstreams) || plan.workstreams.length === 0) {
    throw new Error('enterprise_swarm_plan_invalid');
  }
  const normalizedObjective = String(objective || plan.executiveSummary || '').trim().slice(0, 4000);
  if (!normalizedObjective) throw new Error('enterprise_swarm_objective_required');

  const tasks = [];
  const terminalKeys = [];
  for (const workstream of plan.workstreams) {
    let previousKey = null;
    for (const [taskIndex, sourceTask] of (workstream.tasks || []).entries()) {
      const key = `${slug(workstream.id)}-${slug(sourceTask.id || sourceTask.title)}-${taskIndex + 1}`;
      tasks.push({
        key,
        title: sourceTask.title,
        role: sourceTask.kind === 'external_effect' ? 'reviewer' : 'read-only',
        stage: 'map',
        priority: Math.round(Number(workstream.score) || 0),
        dependsOn: previousKey ? [previousKey] : [],
        input: {
          agent: specialistFor(workstream, sourceTask),
          objective: normalizedObjective,
          workstreamId: workstream.id,
          workstreamTitle: workstream.title,
          sourceTaskId: sourceTask.id,
          kind: sourceTask.kind,
          effect: sourceTask.effect,
          instruction: taskInstruction({
            objective: normalizedObjective,
            workstream,
            task: sourceTask,
          }),
        },
      });
      previousKey = key;
    }
    if (previousKey) terminalKeys.push(previousKey);
  }

  const requested = boundedInteger(
    logicalTasks,
    DEFAULT_LOGICAL_TASKS,
    Math.min(tasks.length + 2, MAX_LOGICAL_TASKS),
    MAX_LOGICAL_TASKS,
  );
  let shardIndex = 0;
  while (tasks.length < requested - 2) {
    const perspective = AUDIT_PERSPECTIVES[shardIndex % AUDIT_PERSPECTIVES.length];
    const key = `parallel-audit-${String(shardIndex + 1).padStart(4, '0')}`;
    tasks.push({
      key,
      title: `Auditoría paralela: ${perspective}`,
      role: 'read-only',
      stage: 'map',
      priority: 20,
      dependsOn: [],
      input: {
        agent: /producto|ventas|correo|contenido/.test(perspective) ? 'enterprise_analyst' : 'explorer',
        objective: normalizedObjective,
        perspective,
        instruction: [
          `Analiza el workspace de forma independiente desde la perspectiva de ${perspective}.`,
          `Objetivo global: ${normalizedObjective}`,
          'Devuelve hallazgos priorizados, rutas o fuentes concretas, riesgos y recomendaciones. No modifiques archivos.',
        ].join('\n'),
      },
    });
    terminalKeys.push(key);
    shardIndex += 1;
  }

  const reviewKey = 'swarm-review';
  tasks.push({
    key: reviewKey,
    title: 'Reducir hallazgos y definir criterios de aceptación',
    role: 'reviewer',
    stage: 'reduce',
    priority: 1_000,
    dependsOn: Array.from(new Set(terminalKeys)),
    input: {
      agent: 'qa_reviewer',
      objective: normalizedObjective,
      instruction: 'Contrasta los hallazgos de los agentes, elimina duplicados y produce un veredicto de QA con prioridades y criterios de aceptación.',
    },
  });
  tasks.push({
    key: 'swarm-integrate',
    title: 'Integrar, verificar y entregar el objetivo',
    role: 'integrator',
    stage: 'integrate',
    priority: 2_000,
    dependsOn: [reviewKey],
    input: {
      objective: normalizedObjective,
      instruction: 'Usa los informes verificados para implementar el objetivo en el workspace, ejecutar pruebas, corregir fallos y dejar un checkpoint comprobable.',
    },
  });

  if (tasks.length > MAX_LOGICAL_TASKS) throw new Error('enterprise_swarm_task_limit');
  return tasks;
}

module.exports = {
  AUDIT_PERSPECTIVES,
  DEFAULT_LOGICAL_TASKS,
  MAX_LOGICAL_TASKS,
  buildEnterpriseSwarmTasks,
};
