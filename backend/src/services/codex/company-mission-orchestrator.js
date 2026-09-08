'use strict';

/**
 * Deterministic CEO Office mission portfolio.
 *
 * The LLM can decide how to execute a mission, but it cannot invent whether a
 * workspace, website, social account or mailbox exists. Missions are derived
 * from the grounded company readiness context, business presence audit,
 * progress ledger and OKRs while preserving the user's autonomy policy.
 */

const PORTFOLIO_VERSION = 2;
const MAX_MISSIONS = 12;
const MAX_AUDIT_FINDINGS = 12;
const MAX_LEDGER_SIGNALS = 12;
const MAX_OBJECTIVES = 12;

const DEPARTMENT_NAMES = Object.freeze({
  'ceo-office': 'CEO Office',
  'agent-infrastructure': 'Infraestructura de Agentes',
  'growth-engines': 'Motores de Crecimiento y Distribución',
  integrations: 'Ecosistema de Integraciones y Conectores',
  'product-engineering': 'Producto e Ingeniería SiraGPT',
  'engineering-01': 'INGENIEROS 01',
  'engineering-02': 'INGENIEROS 02',
  'market-intelligence': 'Inteligencia de Mercado',
  marketing: 'Marketing',
  sales: 'Ventas',
  'customer-success': 'Clientes y Soporte',
  'website-distribution': 'Web y Distribución',
  localization: 'Localización e IA Transcultural',
  trust: 'Confianza, Privacidad y Cumplimiento',
});

const BASE_MISSION_IDS = new Set([
  'company-purpose',
  'customer-offer',
  'code-excellence',
  'agent-orchestration',
  'business-website',
  'social-operations',
  'social-replies',
  'email-operations',
  'sales-operations',
]);

const CODE_DEPARTMENTS = new Set([
  'agent-infrastructure',
  'integrations',
  'product-engineering',
  'engineering-01',
  'engineering-02',
  'website-distribution',
]);

const COMPLETED_SIGNAL_STATUSES = new Set([
  'complete',
  'completed',
  'done',
  'healthy',
  'ok',
  'passed',
  'present',
  'ready',
  'resolved',
]);

const ROUTING_RULES = Object.freeze([
  {
    departmentId: 'trust',
    pattern: /\b(security|secure|privacy|compliance|trust|risk|audit|permission|seguridad|privacidad|cumplimiento|confianza|riesgo|auditoria|permiso)\b/i,
  },
  {
    departmentId: 'localization',
    pattern: /\b(accessibility|a11y|localization|translation|language|locale|region|accesibilidad|localizacion|traduccion|idioma|region)\b/i,
  },
  {
    departmentId: 'agent-infrastructure',
    pattern: /\b(agent|runner|sandbox|orchestrat|fleet|worker|queue|memory|agente|orquest|flota|cola|memoria)\b/i,
  },
  {
    departmentId: 'integrations',
    pattern: /\b(integration|connector|oauth|webhook|mcp|api|integracion|conector)\b/i,
  },
  {
    departmentId: 'customer-success',
    pattern: /\b(customer success|support|inbox|email|gmail|reply|conversation|ticket|soporte|bandeja|correo|respuesta|conversacion)\b/i,
  },
  {
    departmentId: 'sales',
    pattern: /\b(sales|lead|prospect|pipeline|crm|close|revenue|ventas|prospecto|cierre|ingresos)\b/i,
  },
  {
    departmentId: 'marketing',
    pattern: /\b(marketing|campaign|content|brand|social|editorial|campana|contenido|marca|redes)\b/i,
  },
  {
    departmentId: 'growth-engines',
    pattern: /\b(growth|acquisition|activation|retention|conversion|monetization|distribution|crecimiento|adquisicion|activacion|retencion|conversion|monetizacion|distribucion)\b/i,
  },
  {
    departmentId: 'market-intelligence',
    pattern: /\b(market|competitor|research|demand|trend|mercado|competencia|investigacion|demanda|tendencia)\b/i,
  },
  {
    departmentId: 'product-engineering',
    pattern: /\b(website|landing|web|software|product|frontend|backend|code|seo|performance|site|producto|codigo|rendimiento|sitio)\b/i,
  },
  {
    departmentId: 'engineering-02',
    pattern: /\b(quality|test|testing|qa|debug|regression|calidad|prueba|depur|regresion)\b/i,
  },
  {
    departmentId: 'ceo-office',
    pattern: /\b(strategy|mission|vision|purpose|objective|okr|strategy|estrategia|mision|vision|proposito|objetivo)\b/i,
  },
]);

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function boundedText(value, max = 600) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function slug(value, fallback = '') {
  return boundedText(value, 180)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueTexts(values, maxItems = 8, maxLength = 220) {
  return [...new Set(
    asArray(values)
      .map((value) => boundedText(value, maxLength))
      .filter(Boolean),
  )].slice(0, maxItems);
}

function availableDepartmentMap(project) {
  const map = new Map(Object.entries(DEPARTMENT_NAMES));
  const brief = asRecord(project?.brief);
  for (const row of asArray(brief.companyDepartments)) {
    const source = asRecord(row);
    const id = slug(source.id || source.name);
    const name = boundedText(source.name, 120);
    if (id && name) map.set(id.startsWith('custom-') ? id : `custom-${id}`, name);
  }
  return map;
}

function departmentIdFromName(value, departments) {
  const clean = boundedText(value, 180);
  if (!clean) return null;
  const exactId = slug(clean);
  if (departments.has(exactId)) return exactId;
  for (const [departmentId, departmentName] of departments) {
    if (slug(departmentName) === exactId) return departmentId;
  }
  return null;
}

function routeDepartment({
  explicitDepartmentId,
  explicitDepartment,
  text,
  departments,
} = {}) {
  const available = departments instanceof Map ? departments : new Map(Object.entries(DEPARTMENT_NAMES));
  const explicit = departmentIdFromName(explicitDepartmentId, available)
    || departmentIdFromName(explicitDepartment, available);
  if (explicit) return explicit;
  const haystack = boundedText(text, 3_000)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  const match = ROUTING_RULES.find((rule) => (
    available.has(rule.departmentId) && rule.pattern.test(haystack)
  ));
  return match?.departmentId || 'ceo-office';
}

function baselineMissionIdFor(text) {
  const source = boundedText(text, 2_000);
  if (/\b(mission|vision|purpose|mision|vision|proposito)\b/i.test(source)) return 'company-purpose';
  if (/\b(customer|offer|buyer|cliente|oferta)\b/i.test(source)) return 'customer-offer';
  if (/\b(agent|runner|sandbox|orchestrat|fleet|agente|orquest|flota)\b/i.test(source)) return 'agent-orchestration';
  if (/\b(website|landing|web|site|sitio|pagina)\b/i.test(source)) return 'business-website';
  if (/\b(social reply|comment|conversation|respuesta social|comentario|conversacion)\b/i.test(source)) return 'social-replies';
  if (/\b(social|marketing|content|brand|redes|contenido|marca)\b/i.test(source)) return 'social-operations';
  if (/\b(email|gmail|inbox|support|correo|bandeja|soporte)\b/i.test(source)) return 'email-operations';
  if (/\b(sales|lead|prospect|pipeline|crm|ventas|prospecto)\b/i.test(source)) return 'sales-operations';
  if (/\b(software|product|frontend|backend|code|performance|producto|codigo|rendimiento)\b/i.test(source)) return 'code-excellence';
  return null;
}

function severityRank(value, fallback = 45) {
  const clean = boundedText(value, 40).toLowerCase();
  if (['blocker', 'critical', 'critico', 'crítico', 'p0'].includes(clean)) return 5;
  if (['high', 'alto', 'alta', 'p1'].includes(clean)) return 12;
  if (['medium', 'medio', 'media', 'p2'].includes(clean)) return 28;
  if (['low', 'bajo', 'baja', 'p3'].includes(clean)) return 55;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.max(1, Math.min(80, numeric));
  return fallback;
}

function hasCompletedStatus(value) {
  return COMPLETED_SIGNAL_STATUSES.has(boundedText(value, 50).toLowerCase());
}

function signalExecution({
  departmentId,
  workspaceReady,
  codeMode,
  researchEnabled,
} = {}) {
  if (CODE_DEPARTMENTS.has(departmentId)) {
    return {
      status: internalStatus({ available: workspaceReady, mode: codeMode }),
      executionMode: 'code',
      autoExecutable: workspaceReady && codeMode === 'auto',
      approval: codeMode === 'review' ? 'code_changes' : null,
    };
  }
  return {
    status: researchEnabled ? 'ready_to_execute' : 'paused',
    executionMode: 'research',
    autoExecutable: researchEnabled,
    approval: null,
  };
}

function auditContainers({ project, context }) {
  const source = asRecord(context);
  const readiness = asRecord(source.readiness);
  const brief = asRecord(project?.brief);
  return [
    source.presenceAudit,
    source.businessPresenceAudit,
    source.businessAudit,
    source.audit,
    readiness.presenceAudit,
    brief.businessPresenceAudit,
    brief.presenceAudit,
    brief.companyPresenceAudit,
    brief.businessAudit,
  ].filter(Boolean);
}

function auditRows(container) {
  if (Array.isArray(container)) return container.map((row) => ({ row, collection: 'findings' }));
  const source = asRecord(container);
  const rows = [];
  for (const collection of ['findings', 'gaps', 'priorities', 'recommendations', 'issues']) {
    for (const row of asArray(source[collection])) rows.push({ row, collection });
  }
  return rows;
}

function normalizeAuditFindings({ project, context, departments }) {
  const findings = [];
  const seen = new Set();
  for (const container of auditContainers({ project, context })) {
    for (const { row: value, collection } of auditRows(container)) {
      const row = typeof value === 'string' ? { title: value } : asRecord(value);
      const title = boundedText(
        row.title || row.label || row.gap || row.issue || row.name || row.action,
        220,
      );
      const action = boundedText(
        row.nextAction || row.recommendation || row.action || row.objective || row.remediation,
        700,
      );
      const area = boundedText(
        row.area || row.category || row.capability || row.dimension || row.type,
        120,
      );
      const status = boundedText(row.status || row.state, 50);
      const explicitlyPresent = row.present === true || row.exists === true || row.available === true;
      const explicitlyMissing = row.present === false || row.exists === false || row.available === false;
      if (
        !title && !action && !area
        || (!explicitlyMissing
          && (explicitlyPresent || hasCompletedStatus(status))
          && !['recommendations', 'priorities', 'issues'].includes(collection))
      ) {
        continue;
      }
      const id = slug(row.id || row.key || `${area}-${title || action}`, `finding-${findings.length + 1}`);
      if (seen.has(id)) continue;
      seen.add(id);
      const routingText = [area, title, action].filter(Boolean).join(' ');
      findings.push({
        id,
        title: title || action || `Atender brecha de ${area || 'negocio'}`,
        objective: boundedText(row.objective || action || title, 900),
        evidence: boundedText(
          row.evidence || row.detail || row.summary || row.reason
            || (explicitlyMissing ? `${area || title}: presencia no confirmada.` : ''),
          700,
        ),
        nextAction: action || `Resolver la brecha verificada: ${title || area}.`,
        departmentId: routeDepartment({
          explicitDepartmentId: row.departmentId || row.ownerDepartmentId,
          explicitDepartment: row.department || row.owner,
          text: routingText,
          departments,
        }),
        baselineMissionId: baselineMissionIdFor(routingText),
        rank: severityRank(row.severity || row.priority || row.rank),
        sourceRef: `audit:${id}`,
      });
      if (findings.length >= MAX_AUDIT_FINDINGS) return findings;
    }
  }
  return findings;
}

function progressSources({ project, context }) {
  const source = asRecord(context);
  const progress = asRecord(source.progress);
  const brief = asRecord(project?.brief);
  return {
    objectives: [
      ...asArray(source.objectives),
      ...asArray(progress.objectives),
      ...asArray(brief.objectives),
    ],
    ledger: [
      ...asArray(source.ledger),
      ...asArray(progress.ledger),
      ...asArray(brief.ledger),
    ],
  };
}

function normalizeObjectives({ project, context, departments }) {
  const { objectives } = progressSources({ project, context });
  const byId = new Map();
  for (let index = 0; index < objectives.length; index += 1) {
    const row = asRecord(objectives[index]);
    const title = boundedText(row.title || row.objective, 220);
    if (!title) continue;
    const id = boundedText(row.id, 100) || slug(title, `objective-${index + 1}`);
    const status = boundedText(row.status, 50).toLowerCase() || 'active';
    if (['done', 'completed', 'paused', 'cancelled', 'canceled'].includes(status)) {
      byId.delete(id);
      continue;
    }
    const keyResults = asArray(row.keyResults).slice(0, 5);
    const routingText = [
      title,
      row.metric,
      row.target,
      ...keyResults.flatMap((item) => [
        item?.title,
        item?.label,
        item?.metric,
        item?.target,
      ]),
    ].filter(Boolean).join(' ');
    const progressValue = Number(row.progress);
    const priority = Math.max(1, Math.min(5, Number.parseInt(row.priority, 10) || index + 1));
    byId.set(id, {
      id,
      title,
      status,
      priority,
      progress: Number.isFinite(progressValue)
        ? Math.max(0, Math.min(100, Math.round(progressValue)))
        : null,
      departmentId: routeDepartment({
        explicitDepartmentId: row.ownerDepartmentId || row.departmentId,
        explicitDepartment: row.ownerDepartment || row.department || row.owner,
        text: routingText,
        departments,
      }),
      keyResults,
      rank: (status === 'at_risk' ? 7 : 24) + priority,
    });
  }
  return [...byId.values()]
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
    .slice(0, MAX_OBJECTIVES);
}

function normalizeLedgerSignals({ project, context, departments }) {
  const { ledger } = progressSources({ project, context });
  const latest = new Map();
  for (let index = 0; index < ledger.length; index += 1) {
    const row = asRecord(ledger[index]);
    const runId = boundedText(row.runId || row.id, 180);
    const task = boundedText(row.task || row.title || row.summary, 600);
    const missionId = boundedText(row.missionId, 120);
    if (!runId && !task) continue;
    const departmentId = routeDepartment({
      explicitDepartmentId: row.departmentId,
      explicitDepartment: row.department,
      text: `${row.department || ''} ${task} ${asArray(row.learnings).join(' ')}`,
      departments,
    });
    const key = missionId || `${departmentId}:${slug(task, runId || `entry-${index + 1}`)}`;
    latest.set(key, {
      row,
      runId: runId || key,
      task,
      missionId,
      departmentId,
      index,
    });
  }
  return [...latest.values()]
    .filter(({ row }) => ['blocked', 'failed', 'cancelled', 'canceled'].includes(
      boundedText(row.outcome || row.status, 50).toLowerCase(),
    ))
    .sort((a, b) => b.index - a.index)
    .slice(0, MAX_LEDGER_SIGNALS)
    .map(({ row, runId, task, missionId, departmentId }, index) => {
      const outcome = boundedText(row.outcome || row.status, 50).toLowerCase();
      const failedAcceptance = asArray(row.acceptance)
        .filter((item) => item?.passed !== true)
        .map((item) => item?.evidence || item?.criterion);
      const details = uniqueTexts([
        ...failedAcceptance,
        ...asArray(row.learnings),
      ], 4, 260);
      return {
        id: slug(runId, `ledger-${index + 1}`),
        title: task || `Recuperar la corrida ${runId}`,
        objective: `Resolver el bloqueo registrado por ${boundedText(row.department, 120) || 'el ledger'} y cerrar la misión con evidencia verificable.`,
        evidence: details.join(' ') || `La corrida ${runId} terminó como ${outcome}.`,
        nextAction: task
          ? `Revisar la evidencia de ${runId}, corregir la causa y reintentar: ${task}`
          : `Revisar la evidencia de ${runId}, corregir la causa y reintentar.`,
        departmentId,
        baselineMissionId: BASE_MISSION_IDS.has(missionId)
          ? missionId
          : baselineMissionIdFor(`${missionId} ${row.department || ''} ${task}`),
        rank: outcome === 'blocked' ? 8 : outcome === 'failed' ? 10 : 38,
        sourceRef: `ledger:${runId}`,
      };
    });
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
  departmentName = null,
  objectiveIds = [],
  sourceTypes = ['readiness'],
  sourceRefs = [],
  routingReason = null,
  rank = null,
}) {
  return {
    id,
    title,
    departmentId,
    departmentName: departmentName || DEPARTMENT_NAMES[departmentId] || departmentId,
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
    objectiveIds: uniqueTexts(objectiveIds, MAX_OBJECTIVES, 100),
    sourceTypes: uniqueTexts(sourceTypes, 4, 40),
    sourceRefs: uniqueTexts(sourceRefs, 12, 180),
    routingReason: boundedText(routingReason, 400) || null,
    _rank: Number.isFinite(rank) ? rank : 100 + priority,
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

function mergeSignalIntoMission(base, signal, sourceType) {
  return {
    ...base,
    departmentId: signal.departmentId || base.departmentId,
    departmentName: DEPARTMENT_NAMES[signal.departmentId] || base.departmentName,
    evidence: uniqueTexts([signal.evidence, base.evidence], 3, 700).join(' '),
    nextAction: signal.nextAction || base.nextAction,
    objective: signal.objective || base.objective,
    sourceTypes: uniqueTexts([...base.sourceTypes, sourceType], 4, 40),
    sourceRefs: uniqueTexts([...base.sourceRefs, signal.sourceRef], 12, 180),
    routingReason: `CEO Office priorizó y enrutó esta misión desde ${sourceType}.`,
    _rank: Math.min(base._rank, signal.rank),
  };
}

function signalMission({
  signal,
  sourceType,
  departments,
  workspaceReady,
  codeMode,
  researchEnabled,
  objectiveIds = [],
}) {
  const execution = signalExecution({
    departmentId: signal.departmentId,
    workspaceReady,
    codeMode,
    researchEnabled,
  });
  return mission({
    id: `${sourceType}-${slug(signal.id)}`,
    title: signal.title,
    departmentId: signal.departmentId,
    departmentName: departments.get(signal.departmentId),
    priority: 99,
    ...execution,
    objective: signal.objective,
    evidence: signal.evidence,
    nextAction: signal.nextAction,
    sourceArea: null,
    externalEffect: false,
    executor: 'agent-run',
    objectiveIds,
    sourceTypes: [sourceType],
    sourceRefs: [signal.sourceRef || `${sourceType}:${signal.id}`],
    routingReason: `CEO Office derivó la misión al departamento responsable desde ${sourceType}.`,
    rank: signal.rank,
  });
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
  const socialRepliesConnected = socialConnected
    && evidence.socialConnections.some((connection) => connection?.conversationsReady !== false);
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

  const baseMissions = [
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
      departmentId: 'customer-success',
      priority: 7,
      status: externalStatus({
        connected: socialRepliesConnected,
        mode: safeguards.socialReplies || 'review',
      }),
      executionMode: 'external',
      objective: 'Clasificar comentarios y preparar respuestas basadas en la marca, el hilo completo y la política del canal.',
      evidence: social?.evidence,
      nextAction: socialRepliesConnected
        ? safeguards.socialReplies === 'auto'
          ? 'Clasificar conversaciones y responder solo cuando superen política, cuota, permisos e idempotencia.'
          : 'Clasificar conversaciones y preparar respuestas trazables para revisión humana.'
        : socialConnected
          ? 'Reconectar la cuenta social para autorizar lectura y respuesta de conversaciones.'
          : 'Conectar una cuenta OAuth desde Recursos antes de leer o responder comentarios.',
      sourceArea: 'social',
      externalEffect: true,
      autoExecutable: socialRepliesConnected && safeguards.socialReplies === 'auto',
      approval: safeguards.socialReplies === 'review' ? 'social_replies' : null,
      executor: socialRepliesConnected ? 'company-operation' : null,
    }),
    mission({
      id: 'email-operations',
      title: 'Atender el correo del negocio',
      departmentId: 'customer-success',
      priority: 8,
      status: externalStatus({
        connected: gmailConnected,
        mode: safeguards.emailReplies || 'review',
      }),
      executionMode: 'external',
      objective: 'Clasificar correo pendiente, preparar respuestas contextuales y conservar trazabilidad.',
      evidence: email?.evidence,
      nextAction: gmailConnected
        ? safeguards.emailReplies === 'auto'
          ? 'Clasificar pendientes y enviar solo respuestas que superen la política, la cuota y los controles de idempotencia.'
          : 'Clasificar pendientes y preparar borradores trazables para revisión humana.'
        : 'Conectar Gmail desde Recursos antes de leer o responder mensajes.',
      sourceArea: 'email',
      externalEffect: true,
      autoExecutable: gmailConnected && safeguards.emailReplies === 'auto',
      approval: safeguards.emailReplies === 'review' ? 'email_replies' : null,
      executor: gmailConnected ? 'company-operation' : null,
    }),
    mission({
      id: 'sales-operations',
      title: 'Construir el sistema comercial',
      departmentId: customerReady ? 'sales' : 'growth-engines',
      priority: 9,
      status: researchEnabled ? 'ready_to_execute' : 'paused',
      executionMode: 'research',
      objective: 'Definir prospección, calificación, seguimiento y cierre con evidencia, consentimiento y métricas.',
      evidence: sales?.evidence,
      nextAction: customerReady
        ? 'Investigar clientes potenciales con fuentes públicas, guardar oportunidades y preparar contacto bajo revisión.'
        : 'Investigar el mercado y documentar primero un cliente, una oferta y un proceso comercial verificables.',
      sourceArea: 'sales',
      externalEffect: false,
      autoExecutable: researchEnabled,
      approval: null,
      executor: customerReady ? 'company-operation' : 'agent-run',
    }),
  ];

  const departments = availableDepartmentMap(project);
  const audits = normalizeAuditFindings({ project, context: source, departments });
  const ledgerSignals = normalizeLedgerSignals({ project, context: source, departments });
  const objectives = normalizeObjectives({ project, context: source, departments });
  const byId = new Map(baseMissions.map((item) => [item.id, item]));
  const derived = [];

  for (const [sourceType, signals] of [
    ['audit', audits],
    ['ledger', ledgerSignals],
  ]) {
    for (const signal of signals) {
      if (signal.baselineMissionId && byId.has(signal.baselineMissionId)) {
        byId.set(
          signal.baselineMissionId,
          mergeSignalIntoMission(byId.get(signal.baselineMissionId), signal, sourceType),
        );
      } else {
        derived.push(signalMission({
          signal,
          sourceType,
          departments,
          workspaceReady,
          codeMode,
          researchEnabled,
        }));
      }
    }
  }

  for (const objectiveValue of objectives) {
    const keyResults = asArray(objectiveValue.keyResults);
    const target = keyResults
      .map((item) => boundedText(item?.target || item?.title || item?.label, 140))
      .filter(Boolean)
      .slice(0, 3)
      .join('; ');
    derived.push(signalMission({
      signal: {
        ...objectiveValue,
        objective: objectiveValue.title,
        evidence: [
          `OKR ${objectiveValue.status}, prioridad ${objectiveValue.priority}.`,
          objectiveValue.progress == null ? '' : `Progreso confirmado: ${objectiveValue.progress}%.`,
        ].filter(Boolean).join(' '),
        nextAction: objectiveValue.status === 'at_risk'
          ? `Recuperar el OKR y validar el siguiente resultado clave${target ? `: ${target}` : '.'}`
          : `Avanzar el siguiente resultado clave${target ? `: ${target}` : '.'}`,
        sourceRef: `okr:${objectiveValue.id}`,
      },
      sourceType: 'okr',
      departments,
      workspaceReady,
      codeMode,
      researchEnabled,
      objectiveIds: [objectiveValue.id],
    }));
  }

  const missions = [...byId.values(), ...derived]
    .sort((a, b) => a._rank - b._rank || a.priority - b.priority || a.id.localeCompare(b.id))
    .slice(0, MAX_MISSIONS)
    .map(({ _rank, ...item }, index) => ({ ...item, priority: index + 1 }));

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
      sources: {
        auditFindings: audits.length,
        ledgerBlockers: ledgerSignals.length,
        objectives: objectives.length,
      },
    },
    missions,
  };
}

function selectableMissions(portfolio) {
  return (Array.isArray(portfolio?.missions) ? portfolio.missions : [])
    .filter((item) => (
      (item.executor === 'agent-run' && item.status === 'ready_to_execute')
      || (item.executor === 'company-operation'
        && ['ready_to_execute', 'review_required'].includes(item.status))
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
