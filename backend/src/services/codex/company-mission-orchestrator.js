'use strict';

/**
 * Deterministic CEO Office mission portfolio.
 *
 * The LLM can decide how to execute a mission, but it cannot invent whether a
 * workspace, website, social account or mailbox exists. Missions are derived
 * from the grounded company readiness context and the user's autonomy policy.
 */

const PORTFOLIO_VERSION = 1;
const MAX_MISSIONS = 12;

const DEPARTMENT_NAMES = Object.freeze({
  'ceo-office': 'CEO Office',
  'agent-infrastructure': 'Infraestructura de Agentes',
  'growth-engines': 'Motores de Crecimiento y Distribución',
  integrations: 'Ecosistema de Integraciones y Conectores',
  'product-engineering': 'Producto e Ingeniería SiraGPT',
  marketing: 'Marketing',
});

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function boundedText(value, max = 600) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function areaMap(readiness) {
  return new Map(
    (Array.isArray(readiness?.areas) ? readiness.areas : [])
      .filter((area) => area?.id)
      .map((area) => [area.id, area]),
  );
}

function mission({
  id,
  title,
  departmentId,
  priority,
  status,
  executionMode,
  objective,
  evidence,
  nextAction,
  sourceArea = null,
  externalEffect = false,
  autoExecutable = false,
  approval = null,
  executor = null,
}) {
  return {
    id,
    title,
    departmentId,
    departmentName: DEPARTMENT_NAMES[departmentId] || departmentId,
    priority,
    status,
    executionMode,
    objective: boundedText(objective, 900),
    evidence: boundedText(evidence, 700),
    nextAction: boundedText(nextAction, 700),
    sourceArea,
    externalEffect: Boolean(externalEffect),
    autoExecutable: Boolean(autoExecutable),
    approval,
    executor,
  };
}

function internalStatus({ available = true, mode = 'auto' } = {}) {
  if (!available) return 'blocked';
  if (mode === 'off') return 'paused';
  if (mode === 'review') return 'review_required';
  return 'ready_to_execute';
}

function externalStatus({ connected, mode }) {
  if (!connected) return 'blocked_connection';
  if (mode === 'off') return 'paused';
  return mode === 'auto' ? 'ready_to_execute' : 'review_required';
}

function deriveCompanyMissionPortfolio({
  project,
  context,
  now = new Date(),
} = {}) {
  const source = asRecord(context);
  const profile = asRecord(source.profile);
  const readiness = asRecord(source.readiness);
  const safeguards = asRecord(source.safeguards);
  const areas = areaMap(readiness);
  const evidence = asRecord(readiness.evidence);
  const workspaceReady = evidence.workspaceReady === true;
  const socialConnected = Array.isArray(evidence.socialConnections)
    && evidence.socialConnections.length > 0;
  const gmailConnected = evidence.gmailConnected === true;
  const codeMode = profile.autonomy?.codeChanges || 'auto';
  const researchEnabled = profile.autonomy?.research !== false;

  const purpose = areas.get('purpose');
  const customer = areas.get('customer');
  const software = areas.get('software');
  const website = areas.get('website');
  const social = areas.get('social');
  const email = areas.get('email');
  const sales = areas.get('sales');
  const purposeReady = purpose?.status === 'ready';
  const customerReady = customer?.status === 'ready';
  const salesReady = sales?.status === 'ready';

  const missions = [
    mission({
      id: 'company-purpose',
      title: 'Consolidar misión y visión',
      departmentId: 'ceo-office',
      priority: 1,
      status: purposeReady ? 'completed' : researchEnabled ? 'ready_to_execute' : 'paused',
      executionMode: 'research',
      objective: 'Definir una misión y una visión verificables a partir del negocio, el producto, el mercado y la evidencia disponible.',
      evidence: purpose?.evidence,
      nextAction: purposeReady
        ? 'Mantenerlas como criterio de decisión para todos los departamentos.'
        : 'Investigar el negocio y preparar una propuesta fundada sin convertir hipótesis en hechos.',
      sourceArea: 'purpose',
      autoExecutable: !purposeReady && researchEnabled,
      executor: 'agent-run',
    }),
    mission({
      id: 'customer-offer',
      title: 'Validar cliente y oferta',
      departmentId: 'growth-engines',
      priority: 2,
      status: customerReady ? 'completed' : researchEnabled ? 'ready_to_execute' : 'paused',
      executionMode: 'research',
      objective: 'Definir un cliente objetivo, una oferta concreta y señales de mercado que puedan medirse.',
      evidence: customer?.evidence,
      nextAction: customerReady
        ? 'Medir adquisición, activación, retención y conversión.'
        : 'Investigar el mercado y documentar una oferta verificable para un cliente concreto.',
      sourceArea: 'customer',
      autoExecutable: !customerReady && researchEnabled,
      executor: 'agent-run',
    }),
    mission({
      id: 'code-excellence',
      title: 'Elevar el agente de código',
      departmentId: 'product-engineering',
      priority: 3,
      status: internalStatus({ available: workspaceReady, mode: codeMode }),
      executionMode: 'code',
      objective: 'Mejorar el producto de forma incremental con especialistas, ejecución paralela segura, pruebas, preview y evidencia durable.',
      evidence: software?.evidence,
      nextAction: workspaceReady
        ? 'Auditar el siguiente cuello de botella de producto o código y entregar un cambio probado.'
        : 'Recuperar o crear primero un workspace aislado y ejecutable.',
      sourceArea: 'software',
      autoExecutable: workspaceReady && codeMode === 'auto',
      approval: codeMode === 'review' ? 'code_changes' : null,
      executor: 'agent-run',
    }),
    mission({
      id: 'agent-orchestration',
      title: 'Escalar la ingeniería por agentes',
      departmentId: 'agent-infrastructure',
      priority: 4,
      status: internalStatus({ available: workspaceReady, mode: codeMode }),
      executionMode: 'code',
      objective: 'Descomponer trabajo grande en especialistas paralelos, aislar escrituras y verificar la integración antes de cerrar cada corrida.',
      evidence: workspaceReady
        ? 'El workspace aislado está disponible para planificación, subagentes, checkpoints y gates.'
        : software?.evidence,
      nextAction: workspaceReady
        ? 'Seleccionar una tarea paralelizable y medir calidad, tiempo, costo y resultado.'
        : 'Restaurar la capacidad de ejecución antes de ampliar la concurrencia.',
      sourceArea: 'software',
      autoExecutable: workspaceReady && codeMode === 'auto',
      approval: codeMode === 'review' ? 'code_changes' : null,
      executor: 'agent-run',
    }),
    mission({
      id: 'business-website',
      title: website?.status === 'ready' ? 'Mejorar el sitio empresarial' : 'Crear el sitio empresarial',
      departmentId: 'product-engineering',
      priority: 5,
      status: internalStatus({ available: workspaceReady, mode: codeMode }),
      executionMode: 'code',
      objective: 'Crear o mejorar una experiencia web alineada con la oferta, medible, accesible y lista para validación.',
      evidence: website?.evidence,
      nextAction: workspaceReady
        ? website?.status === 'ready'
          ? 'Auditar conversión, contenido, accesibilidad y rendimiento antes de proponer cambios.'
          : 'Construir una landing verificable; publicar solo mediante el control explícito de Publicar.'
        : 'Restaurar el workspace antes de construir el sitio.',
      sourceArea: 'website',
      autoExecutable: workspaceReady && codeMode === 'auto',
      approval: 'publication',
      executor: 'agent-run',
    }),
    mission({
      id: 'social-operations',
      title: 'Operar redes con contexto',
      departmentId: 'marketing',
      priority: 6,
      status: externalStatus({
        connected: socialConnected,
        mode: safeguards.socialPublishing || 'review',
      }),
      executionMode: 'external',
      objective: 'Preparar contenido y respuestas coherentes con la marca, el canal y la conversación real.',
      evidence: social?.evidence,
      nextAction: socialConnected
        ? safeguards.socialPublishing === 'auto'
          ? 'Generar y programar la siguiente pieza bajo los límites e idempotencia configurados.'
          : 'Preparar borradores para revisión; no publicar ni responder sin autorización.'
        : 'Conectar una cuenta OAuth desde Recursos antes de publicar o responder.',
      sourceArea: 'social',
      externalEffect: true,
      autoExecutable: socialConnected && safeguards.socialPublishing === 'auto',
      approval: safeguards.socialPublishing === 'review' ? 'social_publishing' : null,
      executor: 'social-publish',
    }),
    mission({
      id: 'social-replies',
      title: 'Responder conversaciones sociales',
      departmentId: 'marketing',
      priority: 7,
      status: socialConnected ? 'integration_required' : 'blocked_connection',
      executionMode: 'external',
      objective: 'Clasificar comentarios y preparar respuestas basadas en la marca, el hilo completo y la política del canal.',
      evidence: social?.evidence,
      nextAction: socialConnected
        ? 'Habilitar un despachador auditado de comentarios antes de responder; mientras tanto, preparar borradores sin publicarlos.'
        : 'Conectar una cuenta OAuth desde Recursos antes de leer o responder comentarios.',
      sourceArea: 'social',
      externalEffect: true,
      autoExecutable: false,
      approval: safeguards.socialReplies === 'review' ? 'social_replies' : null,
    }),
    mission({
      id: 'email-operations',
      title: 'Atender el correo del negocio',
      departmentId: 'integrations',
      priority: 8,
      status: gmailConnected ? 'integration_required' : 'blocked_connection',
      executionMode: 'external',
      objective: 'Clasificar correo pendiente, preparar respuestas contextuales y conservar trazabilidad.',
      evidence: email?.evidence,
      nextAction: gmailConnected
        ? 'Habilitar un despachador auditado; hasta entonces, preparar respuestas para revisión sin enviarlas.'
        : 'Conectar Gmail desde Recursos antes de leer o responder mensajes.',
      sourceArea: 'email',
      externalEffect: true,
      autoExecutable: false,
      approval: safeguards.emailReplies === 'review' ? 'email_replies' : null,
    }),
    mission({
      id: 'sales-operations',
      title: 'Construir el sistema comercial',
      departmentId: 'growth-engines',
      priority: 9,
      status: salesReady
        ? (gmailConnected || socialConnected ? 'integration_required' : 'blocked_connection')
        : researchEnabled ? 'ready_to_execute' : 'paused',
      executionMode: salesReady ? 'external' : 'research',
      objective: 'Definir prospección, calificación, seguimiento y cierre con evidencia, consentimiento y métricas.',
      evidence: sales?.evidence,
      nextAction: salesReady
        ? gmailConnected || socialConnected
          ? 'Habilitar un despachador comercial auditado; hasta entonces, preparar oportunidades y mensajes sin enviarlos.'
          : 'Conectar un canal autorizado antes de contactar oportunidades.'
        : 'Investigar el mercado y documentar primero un proceso comercial verificable.',
      sourceArea: 'sales',
      externalEffect: salesReady,
      autoExecutable: salesReady
        ? false
        : researchEnabled,
      approval: salesReady && safeguards.leadOutreach === 'review' ? 'lead_outreach' : null,
      executor: salesReady ? null : 'agent-run',
    }),
  ].slice(0, MAX_MISSIONS);

  const counts = missions.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});
  const actionable = missions.filter((item) => (
    item.status === 'ready_to_execute'
    || (item.status === 'review_required' && item.id === 'social-operations')
  ));

  return {
    version: PORTFOLIO_VERSION,
    generatedAt: now.toISOString(),
    companyName: boundedText(profile.companyName || project?.name, 120) || 'Empresa',
    summary: {
      total: missions.length,
      readyToExecute: counts.ready_to_execute || 0,
      reviewRequired: counts.review_required || 0,
      blocked: (counts.blocked || 0)
        + (counts.blocked_connection || 0)
        + (counts.integration_required || 0),
      completed: counts.completed || 0,
      paused: counts.paused || 0,
      highestPriorityMissionId: actionable[0]?.id || null,
    },
    missions,
  };
}

function selectableMissions(portfolio) {
  return (Array.isArray(portfolio?.missions) ? portfolio.missions : [])
    .filter((item) => (
      (item.executor === 'agent-run' && item.status === 'ready_to_execute')
      || (item.executor === 'social-publish'
        && ['ready_to_execute', 'review_required'].includes(item.status))
    ))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

function selectMissionForCycle(portfolio, cursor = 0) {
  const missions = selectableMissions(portfolio);
  if (!missions.length) return null;
  const index = Math.max(0, Number.parseInt(cursor, 10) || 0) % missions.length;
  return missions[index];
}

function formatMissionContext(missionValue) {
  const selected = asRecord(missionValue);
  if (!selected.id) return '';
  return [
    `Misión priorizada por CEO Office: ${boundedText(selected.title, 180)}`,
    `Identificador: ${boundedText(selected.id, 100)}`,
    `Estado: ${boundedText(selected.status, 80)}`,
    `Modo de ejecución: ${boundedText(selected.executionMode, 80)}`,
    `Objetivo: ${boundedText(selected.objective, 900)}`,
    `Evidencia: ${boundedText(selected.evidence, 700) || 'sin evidencia adicional'}`,
    `Siguiente acción: ${boundedText(selected.nextAction, 700)}`,
    selected.externalEffect
      ? 'Regla de efecto externo: prepara borrador o ejecuta únicamente si la conexión y la política explícita lo permiten.'
      : 'Regla de ejecución: entrega cambios o investigación con evidencia verificable.',
  ].join('\n');
}

module.exports = {
  PORTFOLIO_VERSION,
  deriveCompanyMissionPortfolio,
  formatMissionContext,
  selectMissionForCycle,
  selectableMissions,
};
