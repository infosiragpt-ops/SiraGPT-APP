'use strict';

const crypto = require('node:crypto');

const PLAN_SCHEMA_VERSION = 'sira.company-autopilot-plan.v1';
const MAX_EXECUTIVE_SUMMARY_LENGTH = 320;

const TASK_KINDS = Object.freeze({
  RESEARCH: 'research',
  DRAFT: 'draft',
  EXTERNAL_EFFECT: 'external_effect',
});

const EFFECT_LEVELS = Object.freeze({
  READ_ONLY: 'read_only',
  INTERNAL_WRITE: 'internal_write',
  EXTERNAL_WRITE: 'external_write',
});

const EXTERNAL_ACTIONS = Object.freeze({
  DEPLOY_LANDING: 'software.deploy_landing',
  PUBLISH_SOCIAL: 'social.publish_content',
  RESPOND_SOCIAL: 'social.respond_to_comments',
  RESPOND_INBOX: 'inbox.respond_to_customers',
  CONTACT_LEADS: 'sales.contact_leads',
  CLOSE_SALE: 'sales.close_sale',
});

const WORKSTREAM_ORDER = Object.freeze([
  'mission_vision',
  'software_landing',
  'social_presence',
  'inbox_customer_service',
  'customer_acquisition_sales',
  'quality_assurance',
]);

const DEPARTMENTS = Object.freeze({
  STRATEGY: {
    id: 'strategy',
    label: 'Estrategia y Dirección',
  },
  ENGINEERING: {
    id: 'engineering',
    label: 'Producto e Ingeniería',
  },
  MARKETING: {
    id: 'marketing',
    label: 'Marketing y Contenido',
  },
  CUSTOMER_SUCCESS: {
    id: 'customer_success',
    label: 'Atención al Cliente',
  },
  SALES: {
    id: 'sales',
    label: 'Ventas y Desarrollo de Negocio',
  },
  QUALITY: {
    id: 'quality',
    label: 'Calidad, Riesgo y Cumplimiento',
  },
});

const AUTO_POLICY_PATHS = Object.freeze({
  [EXTERNAL_ACTIONS.DEPLOY_LANDING]: [
    'automationPolicies.software.deploy',
    'automationPolicies.website.deploy',
    'autoPolicies.deployLanding',
    'policies.websiteDeploy',
    'externalActions.deployLanding',
  ],
  [EXTERNAL_ACTIONS.PUBLISH_SOCIAL]: [
    'automationPolicies.social.publish',
    'autoPolicies.publishSocial',
    'policies.socialPublishing',
    'externalActions.publishSocial',
  ],
  [EXTERNAL_ACTIONS.RESPOND_SOCIAL]: [
    'automationPolicies.social.respond',
    'autoPolicies.respondSocial',
    'policies.socialResponses',
    'externalActions.respondSocial',
  ],
  [EXTERNAL_ACTIONS.RESPOND_INBOX]: [
    'automationPolicies.inbox.respond',
    'autoPolicies.respondInbox',
    'policies.inboxResponses',
    'externalActions.respondInbox',
  ],
  [EXTERNAL_ACTIONS.CONTACT_LEADS]: [
    'automationPolicies.sales.contactLeads',
    'autoPolicies.contactLeads',
    'policies.leadOutreach',
    'externalActions.contactLeads',
  ],
  [EXTERNAL_ACTIONS.CLOSE_SALE]: [
    'automationPolicies.sales.closeSales',
    'autoPolicies.closeSales',
    'policies.salesClosing',
    'externalActions.closeSales',
  ],
});

const CONNECTION_PATHS = Object.freeze({
  deployment: [
    'connections.deployment',
    'connections.hosting',
    'integrations.deployment',
    'integrations.hosting',
    'software.deploymentConnection',
    'website.deploymentConnection',
  ],
  social: [
    'connections.social',
    'integrations.social',
    'social.connected',
    'socialAccounts.connected',
  ],
  inbox: [
    'connections.inbox',
    'connections.email',
    'integrations.inbox',
    'integrations.email',
    'inbox.connected',
    'email.connected',
  ],
  crm: [
    'connections.crm',
    'integrations.crm',
    'sales.crm.connected',
    'crm.connected',
  ],
  billing: [
    'connections.billing',
    'connections.payments',
    'integrations.billing',
    'integrations.payments',
    'billing.connected',
    'payments.connected',
  ],
  contracts: [
    'connections.contracts',
    'connections.esign',
    'integrations.contracts',
    'integrations.esign',
    'contracts.connected',
  ],
  sales: [
    'connections.sales',
    'integrations.sales',
    'sales.connected',
  ],
});

function buildCompanyAutopilotPlan(input = {}) {
  const { companyOperatingProfile, readiness } = normalizePlannerInput(input);
  const context = buildOperatingContext(companyOperatingProfile, readiness);

  const workstreams = [
    buildMissionVisionWorkstream(context),
    buildSoftwareLandingWorkstream(context),
    buildSocialWorkstream(context),
    buildInboxWorkstream(context),
    buildSalesWorkstream(context),
    buildQaWorkstream(context),
  ].sort(compareWorkstreams);

  const externalTasks = workstreams.flatMap((workstream) => (
    workstream.tasks.filter((task) => task.kind === TASK_KINDS.EXTERNAL_EFFECT)
  ));
  const proposals = externalTasks
    .filter((task) => task.execution.mode === 'proposal')
    .map(toExternalProposal);
  const approvalQueue = externalTasks
    .filter((task) => task.execution.requiresApproval)
    .map(toApprovalRequest);
  const executionRoutes = workstreams.map(toExecutionRoute);

  const plan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    planId: makePlanId({ context, workstreams }),
    companyMode: context.companyMode,
    companyName: context.companyName,
    executiveSummary: buildExecutiveSummary(context, workstreams, externalTasks),
    operatingContext: {
      companyMode: context.companyMode,
      companyName: context.companyName,
      readiness: { ...context.readiness },
      connections: { ...context.connections },
      policies: { ...context.policies },
    },
    governance: {
      defaultExternalActionMode: 'proposal_and_approval',
      externalCompletionRule: 'never_claim_completed_without_execution_evidence',
      autoExecutionRule: 'verified_connection_and_explicit_auto_policy_required',
      approvalRule: 'external_actions_default_to_human_approval',
      qualityGate: 'quality_review_before_external_execution',
    },
    priorities: workstreams.map((workstream, index) => ({
      rank: index + 1,
      workstreamId: workstream.id,
      department: workstream.department,
      priority: workstream.priority,
      score: workstream.score,
      status: workstream.status,
    })),
    workstreams,
    executionRoutes,
    proposals,
    approvalQueue,
    summary: summarizePlan(workstreams, externalTasks, proposals, approvalQueue),
    llmEnhancement: {
      applied: false,
      reason: 'not_requested',
    },
  };

  const validation = validateCompanyAutopilotPlan(plan);
  if (!validation.ok) {
    throw new Error(`company-autopilot-planner: invalid plan: ${validation.errors.join('; ')}`);
  }

  return plan;
}

async function buildCompanyAutopilotPlanWithLlm(input = {}, deps = {}) {
  const basePlan = buildCompanyAutopilotPlan(input);
  const llm = deps.llm || input.llm;
  if (!llm) return basePlan;

  const invoke = resolveLlmInvoker(llm);
  if (!invoke) {
    return {
      ...basePlan,
      llmEnhancement: {
        applied: false,
        reason: 'invalid_llm_adapter',
      },
    };
  }

  try {
    const response = await invoke(buildLlmRequest(basePlan));
    const patch = parseLlmNarrativePatch(response);
    if (!patch) {
      return {
        ...basePlan,
        llmEnhancement: {
          applied: false,
          reason: 'invalid_llm_response',
        },
      };
    }

    const enhanced = applySafeNarrativePatch(basePlan, patch);
    return {
      ...enhanced,
      llmEnhancement: {
        applied: enhanced !== basePlan,
        reason: enhanced !== basePlan ? 'safe_narrative_applied' : 'no_safe_changes',
      },
    };
  } catch (_error) {
    return {
      ...basePlan,
      llmEnhancement: {
        applied: false,
        reason: 'llm_failed',
      },
    };
  }
}

function normalizePlannerInput(input) {
  if (!isPlainObject(input)) {
    throw new TypeError('company-autopilot-planner: input must be an object');
  }

  const companyOperatingProfile = input.companyOperatingProfile ?? input.operatingProfile ?? {};
  const readiness = input.readiness ?? input.companyReadiness ?? {};

  if (!isPlainObject(companyOperatingProfile)) {
    throw new TypeError('company-autopilot-planner: companyOperatingProfile must be an object');
  }
  if (!isPlainObject(readiness)) {
    throw new TypeError('company-autopilot-planner: readiness must be an object');
  }

  return { companyOperatingProfile, readiness };
}

function buildOperatingContext(profile, readiness) {
  const companyMode = inferCompanyMode(profile, readiness);
  const companyName = cleanText(readFirst(profile, [
    'companyName',
    'name',
    'company.name',
    'business.name',
  ]), 100) || (companyMode === 'new' ? 'Nueva empresa' : 'Empresa');

  const capabilities = {
    mission: hasMeaningfulText(readFirst(profile, [
      'mission',
      'strategy.mission',
      'company.mission',
    ])) || isReady(readFirst(readiness, ['mission', 'strategy.mission'])),
    vision: hasMeaningfulText(readFirst(profile, [
      'vision',
      'strategy.vision',
      'company.vision',
    ])) || isReady(readFirst(readiness, ['vision', 'strategy.vision'])),
    software: isReady(readFirst(profile, [
      'software.exists',
      'software.ready',
      'digitalProduct.exists',
      'product.exists',
    ])) || isReady(readFirst(readiness, [
      'software',
      'software.ready',
      'digitalProduct',
      'product',
    ])),
    landing: isReady(readFirst(profile, [
      'landing.exists',
      'landingPage.exists',
      'website.exists',
      'website.ready',
    ])) || hasMeaningfulText(readFirst(profile, [
      'landing.url',
      'landingPage.url',
      'website.url',
      'domain',
    ])) || isReady(readFirst(readiness, [
      'landing',
      'landingPage',
      'website',
    ])),
    socialPresence: hasConnectedSocialAccount(profile, readiness)
      || isReady(readFirst(readiness, ['socialPresence', 'social.presence'])),
    socialStrategy: isReady(readFirst(profile, [
      'social.strategyReady',
      'social.contentPlanReady',
    ])) || isReady(readFirst(readiness, [
      'socialStrategy',
      'social.strategy',
      'social.contentPlan',
    ])),
    inboxProcess: isReady(readFirst(profile, [
      'inbox.processReady',
      'customerService.processReady',
      'support.processReady',
    ])) || isReady(readFirst(readiness, [
      'inboxProcess',
      'inbox.process',
      'customerService',
      'support',
    ])),
    idealCustomerProfile: hasMeaningfulText(readFirst(profile, [
      'idealCustomerProfile',
      'sales.idealCustomerProfile',
      'customers.idealProfile',
    ])) || isReady(readFirst(readiness, [
      'idealCustomerProfile',
      'sales.idealCustomerProfile',
    ])),
    salesPipeline: isReady(readFirst(profile, [
      'sales.pipelineReady',
      'sales.pipeline.exists',
      'crm.pipelineReady',
    ])) || isReady(readFirst(readiness, [
      'salesPipeline',
      'sales.pipeline',
      'crm.pipeline',
    ])),
    qualitySystem: isReady(readFirst(profile, [
      'quality.systemReady',
      'qa.ready',
      'governance.ready',
    ])) || isReady(readFirst(readiness, [
      'quality',
      'qa',
      'governance',
    ])),
    metrics: isReady(readFirst(profile, [
      'metrics.configured',
      'analytics.configured',
      'kpis.defined',
    ])) || isReady(readFirst(readiness, [
      'metrics',
      'analytics',
      'kpis',
    ])),
  };

  const connections = {
    deployment: hasConnection('deployment', profile, readiness),
    social: hasConnection('social', profile, readiness) || hasConnectedSocialAccount(profile, readiness),
    inbox: hasConnection('inbox', profile, readiness),
    crm: hasConnection('crm', profile, readiness),
    billing: hasConnection('billing', profile, readiness),
    contracts: hasConnection('contracts', profile, readiness),
    sales: hasConnection('sales', profile, readiness),
  };

  const policies = {};
  for (const action of Object.values(EXTERNAL_ACTIONS)) {
    policies[action] = resolveAutoPolicy(action, profile, readiness);
  }

  return {
    companyMode,
    companyName,
    readiness: capabilities,
    connections,
    policies,
  };
}

function buildMissionVisionWorkstream(context) {
  const missing = countFalse([
    context.readiness.mission,
    context.readiness.vision,
  ]);
  const score = calculateScore({
    base: 55,
    missing,
    modeBoost: context.companyMode === 'new' ? 30 : 5,
    complete: missing === 0,
  });

  return buildWorkstream({
    id: 'mission_vision',
    title: 'Misión, visión y dirección estratégica',
    department: DEPARTMENTS.STRATEGY,
    score,
    readinessScore: percentageReady([
      context.readiness.mission,
      context.readiness.vision,
    ]),
    rationale: missing
      ? 'Define el propósito, el horizonte y los criterios con los que CEO Office priorizará el resto del plan.'
      : 'La base estratégica existe; corresponde validarla contra mercado, clientes y decisiones actuales.',
    tasks: [
      researchTask({
        id: 'mission_vision.research',
        department: DEPARTMENTS.STRATEGY,
        title: 'Investigar mercado, clientes, problema y diferenciadores',
        output: 'Mapa de evidencia, supuestos y oportunidades con fuentes.',
      }),
      draftTask({
        id: 'mission_vision.draft',
        department: DEPARTMENTS.STRATEGY,
        title: 'Redactar o actualizar misión, visión y principios operativos',
        output: 'Borrador ejecutivo de misión, visión, objetivos y límites.',
      }),
      draftTask({
        id: 'mission_vision.align',
        department: DEPARTMENTS.STRATEGY,
        title: 'Traducir la estrategia a objetivos medibles',
        output: 'Objetivos, indicadores, responsables y horizonte de revisión.',
      }),
    ],
  });
}

function buildSoftwareLandingWorkstream(context) {
  const missing = countFalse([
    context.readiness.software,
    context.readiness.landing,
  ]);
  const score = calculateScore({
    base: 52,
    missing,
    modeBoost: context.companyMode === 'new' ? 24 : 12,
    complete: missing === 0,
  });

  return buildWorkstream({
    id: 'software_landing',
    title: 'Software, landing y activos digitales',
    department: DEPARTMENTS.ENGINEERING,
    score,
    readinessScore: percentageReady([
      context.readiness.software,
      context.readiness.landing,
    ]),
    rationale: missing
      ? 'Cierra los vacíos del producto y del canal de conversión antes de escalar adquisición.'
      : 'Los activos existen; el foco pasa a rendimiento, conversión, seguridad y mejora continua.',
    tasks: [
      researchTask({
        id: 'software_landing.audit',
        department: DEPARTMENTS.ENGINEERING,
        title: 'Auditar producto, landing, dominio, analítica, SEO y accesibilidad',
        output: 'Diagnóstico técnico y comercial con evidencia y riesgos.',
      }),
      draftTask({
        id: 'software_landing.solution',
        department: DEPARTMENTS.ENGINEERING,
        title: 'Diseñar la arquitectura y el backlog priorizado',
        output: 'Arquitectura, journeys, criterios de aceptación y plan de entrega.',
      }),
      draftTask({
        id: 'software_landing.build',
        department: DEPARTMENTS.ENGINEERING,
        title: 'Preparar código, contenido y pruebas en un entorno controlado',
        output: 'Cambio versionado, preview, pruebas y reporte de QA.',
      }),
      externalTask({
        id: 'software_landing.deploy',
        action: EXTERNAL_ACTIONS.DEPLOY_LANDING,
        department: DEPARTMENTS.ENGINEERING,
        title: 'Desplegar o actualizar la landing',
        output: 'Versión publicada con URL, revisión visual y evidencia de despliegue.',
        connectionRequirements: [
          { anyOf: ['deployment'], label: 'hosting o proveedor de despliegue' },
        ],
        context,
      }),
    ],
  });
}

function buildSocialWorkstream(context) {
  const missing = countFalse([
    context.readiness.socialPresence,
    context.readiness.socialStrategy,
  ]);
  const score = calculateScore({
    base: 43,
    missing,
    modeBoost: context.companyMode === 'existing' ? 13 : 6,
    complete: missing === 0,
  });

  return buildWorkstream({
    id: 'social_presence',
    title: 'Redes sociales y contenido',
    department: DEPARTMENTS.MARKETING,
    score,
    readinessScore: percentageReady([
      context.readiness.socialPresence,
      context.readiness.socialStrategy,
    ]),
    rationale: missing
      ? 'Construye una presencia coherente y un sistema editorial antes de automatizar publicaciones o respuestas.'
      : 'La presencia está activa; corresponde optimizar contenido, conversación y aprendizaje por canal.',
    tasks: [
      researchTask({
        id: 'social_presence.research',
        department: DEPARTMENTS.MARKETING,
        title: 'Investigar audiencia, canales, competidores y conversación pública',
        output: 'Mapa de canales, temas, formatos, riesgos y oportunidades con fuentes.',
      }),
      draftTask({
        id: 'social_presence.editorial',
        department: DEPARTMENTS.MARKETING,
        title: 'Preparar estrategia editorial y piezas por canal',
        output: 'Calendario, borradores de texto, briefs visuales y guía de respuestas.',
      }),
      externalTask({
        id: 'social_presence.publish',
        action: EXTERNAL_ACTIONS.PUBLISH_SOCIAL,
        department: DEPARTMENTS.MARKETING,
        title: 'Publicar contenido en redes conectadas',
        output: 'Publicaciones con identificadores remotos y evidencia verificable.',
        connectionRequirements: [
          { anyOf: ['social'], label: 'cuenta social conectada' },
        ],
        context,
      }),
      externalTask({
        id: 'social_presence.respond',
        action: EXTERNAL_ACTIONS.RESPOND_SOCIAL,
        department: DEPARTMENTS.MARKETING,
        title: 'Responder comentarios con contexto de marca',
        output: 'Respuestas enviadas con referencia al comentario y registro de auditoría.',
        connectionRequirements: [
          { anyOf: ['social'], label: 'cuenta social conectada' },
        ],
        context,
      }),
    ],
  });
}

function buildInboxWorkstream(context) {
  const missing = countFalse([
    context.connections.inbox,
    context.readiness.inboxProcess,
  ]);
  const score = calculateScore({
    base: 50,
    missing,
    modeBoost: context.companyMode === 'existing' ? 22 : 5,
    complete: missing === 0,
  });

  return buildWorkstream({
    id: 'inbox_customer_service',
    title: 'Inbox y atención al cliente',
    department: DEPARTMENTS.CUSTOMER_SUCCESS,
    score,
    readinessScore: percentageReady([
      context.connections.inbox,
      context.readiness.inboxProcess,
    ]),
    rationale: missing
      ? 'Evita perder solicitudes y establece respuestas consistentes antes de habilitar automatización.'
      : 'El canal está preparado; el foco es mantener SLA, contexto y calidad de respuesta.',
    tasks: [
      researchTask({
        id: 'inbox_customer_service.review',
        department: DEPARTMENTS.CUSTOMER_SUCCESS,
        title: 'Revisar bandejas, categorías, SLA y mensajes pendientes',
        output: 'Inventario de conversaciones, prioridad, intención y riesgo; sin enviar respuestas.',
      }),
      draftTask({
        id: 'inbox_customer_service.drafts',
        department: DEPARTMENTS.CUSTOMER_SUCCESS,
        title: 'Preparar borradores de respuesta contextualizados',
        output: 'Borradores revisables con contexto, tono, siguiente paso y escalamiento.',
      }),
      externalTask({
        id: 'inbox_customer_service.respond',
        action: EXTERNAL_ACTIONS.RESPOND_INBOX,
        department: DEPARTMENTS.CUSTOMER_SUCCESS,
        title: 'Responder mensajes de clientes',
        output: 'Mensajes enviados con identificador, destinatario y registro de auditoría.',
        connectionRequirements: [
          { anyOf: ['inbox'], label: 'bandeja de correo o soporte conectada' },
        ],
        context,
      }),
    ],
  });
}

function buildSalesWorkstream(context) {
  const missing = countFalse([
    context.readiness.idealCustomerProfile,
    context.readiness.salesPipeline,
    context.connections.crm || context.connections.sales,
  ]);
  const score = calculateScore({
    base: 49,
    missing,
    modeBoost: context.companyMode === 'existing' ? 20 : 8,
    complete: missing === 0,
  });

  return buildWorkstream({
    id: 'customer_acquisition_sales',
    title: 'Clientes, oportunidades y ventas',
    department: DEPARTMENTS.SALES,
    score,
    readinessScore: percentageReady([
      context.readiness.idealCustomerProfile,
      context.readiness.salesPipeline,
      context.connections.crm || context.connections.sales,
    ]),
    rationale: missing
      ? 'Define clientes adecuados y un proceso trazable antes de contactar personas o comprometer condiciones comerciales.'
      : 'El proceso comercial está preparado; corresponde mejorar calidad de oportunidades, conversión y seguimiento.',
    tasks: [
      researchTask({
        id: 'customer_acquisition_sales.research',
        department: DEPARTMENTS.SALES,
        title: 'Investigar segmentos, cuentas y señales públicas de necesidad',
        output: 'Lista de oportunidades justificadas, fuentes, encaje y límites de contacto.',
      }),
      draftTask({
        id: 'customer_acquisition_sales.pipeline',
        department: DEPARTMENTS.SALES,
        title: 'Preparar pipeline, mensajes y propuestas comerciales',
        output: 'Borradores personalizados, etapas, criterios de calificación y próximos pasos.',
      }),
      externalTask({
        id: 'customer_acquisition_sales.contact',
        action: EXTERNAL_ACTIONS.CONTACT_LEADS,
        department: DEPARTMENTS.SALES,
        title: 'Contactar leads calificados',
        output: 'Contactos enviados con base legítima, canal, destinatario y evidencia.',
        connectionRequirements: [
          { anyOf: ['inbox', 'social', 'sales'], label: 'canal de contacto conectado' },
          { anyOf: ['crm', 'sales'], label: 'CRM o sistema comercial conectado' },
        ],
        context,
      }),
      externalTask({
        id: 'customer_acquisition_sales.close',
        action: EXTERNAL_ACTIONS.CLOSE_SALE,
        department: DEPARTMENTS.SALES,
        title: 'Formalizar y cerrar una venta',
        output: 'Aceptación verificable, condiciones, contrato y transacción registrados.',
        connectionRequirements: [
          { anyOf: ['crm', 'sales'], label: 'CRM o sistema comercial conectado' },
          { anyOf: ['billing', 'sales'], label: 'facturación o pagos conectados' },
          { anyOf: ['contracts', 'sales'], label: 'contratos o firma conectados' },
        ],
        context,
      }),
    ],
  });
}

function buildQaWorkstream(context) {
  const missing = countFalse([
    context.readiness.qualitySystem,
    context.readiness.metrics,
  ]);
  const score = calculateScore({
    base: 58,
    missing,
    modeBoost: 12,
    complete: missing === 0,
  });

  return buildWorkstream({
    id: 'quality_assurance',
    title: 'QA, métricas y control operativo',
    department: DEPARTMENTS.QUALITY,
    score,
    readinessScore: percentageReady([
      context.readiness.qualitySystem,
      context.readiness.metrics,
    ]),
    rationale: missing
      ? 'Define evidencia y controles para detectar trabajo incompleto antes de cualquier efecto externo.'
      : 'Los controles existen; corresponde ejecutar revisiones continuas y reparar desviaciones.',
    tasks: [
      researchTask({
        id: 'quality_assurance.audit',
        department: DEPARTMENTS.QUALITY,
        title: 'Auditar evidencia, riesgos, seguridad, métricas y cumplimiento',
        output: 'Matriz de hallazgos, severidad, evidencia y responsable.',
      }),
      draftTask({
        id: 'quality_assurance.gates',
        department: DEPARTMENTS.QUALITY,
        title: 'Preparar criterios de aceptación y plan de reparación',
        output: 'Checklist verificable, pruebas, umbrales y acciones correctivas.',
      }),
      researchTask({
        id: 'quality_assurance.verify',
        department: DEPARTMENTS.QUALITY,
        title: 'Verificar entregables antes de autorizar efectos externos',
        output: 'Veredicto listo, bloqueado o requiere revisión, siempre respaldado por evidencia.',
      }),
    ],
  });
}

function buildWorkstream({
  id,
  title,
  department,
  score,
  readinessScore,
  rationale,
  tasks,
}) {
  const priority = score >= 82 ? 'P0' : score >= 58 ? 'P1' : 'P2';
  const status = readinessScore === 100 ? 'maintain_and_improve' : 'gap_detected';
  return {
    id,
    title,
    department: department.id,
    departmentLabel: department.label,
    priority,
    score,
    readinessScore,
    status,
    rationale,
    route: ['CEO Office', department.label, DEPARTMENTS.QUALITY.label, 'CEO Office'],
    tasks,
    acceptanceCriteria: [
      'Cada afirmación de avance tiene evidencia verificable.',
      'Los borradores se distinguen de acciones ejecutadas.',
      'QA revisa el resultado antes de cualquier efecto externo.',
      'Ningún efecto externo se declara completado sin identificador o evidencia remota.',
    ],
  };
}

function researchTask({ id, department, title, output }) {
  return {
    id,
    title,
    department: department.id,
    departmentLabel: department.label,
    kind: TASK_KINDS.RESEARCH,
    effect: EFFECT_LEVELS.READ_ONLY,
    status: 'planned',
    output,
    evidenceRequired: true,
    execution: {
      mode: 'read_only',
      requiresApproval: false,
      canAutoExecute: true,
      completionClaimAllowed: false,
    },
  };
}

function draftTask({ id, department, title, output }) {
  return {
    id,
    title,
    department: department.id,
    departmentLabel: department.label,
    kind: TASK_KINDS.DRAFT,
    effect: EFFECT_LEVELS.INTERNAL_WRITE,
    status: 'planned',
    output,
    evidenceRequired: true,
    execution: {
      mode: 'draft',
      requiresApproval: false,
      canAutoExecute: true,
      completionClaimAllowed: false,
    },
  };
}

function externalTask({
  id,
  action,
  department,
  title,
  output,
  connectionRequirements,
  context,
}) {
  const execution = resolveExternalExecution({
    action,
    connectionRequirements,
    connections: context.connections,
    policy: context.policies[action],
  });

  return {
    id,
    title,
    department: department.id,
    departmentLabel: department.label,
    kind: TASK_KINDS.EXTERNAL_EFFECT,
    effect: EFFECT_LEVELS.EXTERNAL_WRITE,
    action,
    status: execution.status,
    output,
    evidenceRequired: true,
    resultClaim: 'not_executed',
    execution,
  };
}

function resolveExternalExecution({
  action,
  connectionRequirements = [],
  connections = {},
  policy = 'approval',
}) {
  const requirements = connectionRequirements.map((requirement) => {
    const satisfiedBy = requirement.anyOf.filter((connection) => connections[connection] === true);
    return {
      label: requirement.label,
      anyOf: [...requirement.anyOf],
      satisfied: satisfiedBy.length > 0,
      satisfiedBy,
    };
  });
  const connectionVerified = requirements.every((requirement) => requirement.satisfied);
  const autoPolicyEnabled = policy === 'auto';

  if (!connectionVerified) {
    return {
      mode: 'proposal',
      status: 'proposal_required',
      policy,
      connectionVerified: false,
      autoPolicyEnabled,
      canAutoExecute: false,
      requiresApproval: true,
      completionClaimAllowed: false,
      completionEvidenceRequired: true,
      requirements,
      blockers: requirements
        .filter((requirement) => !requirement.satisfied)
        .map((requirement) => `missing_connection:${requirement.label}`),
      nextStep: 'Proponer la acción, conectar el proveedor y solicitar aprobación.',
      action,
    };
  }

  if (!autoPolicyEnabled) {
    return {
      mode: 'approval',
      status: 'approval_required',
      policy,
      connectionVerified: true,
      autoPolicyEnabled: false,
      canAutoExecute: false,
      requiresApproval: true,
      completionClaimAllowed: false,
      completionEvidenceRequired: true,
      requirements,
      blockers: ['explicit_auto_policy_missing'],
      nextStep: 'Presentar la propuesta y esperar aprobación humana.',
      action,
    };
  }

  return {
    mode: 'auto',
    status: 'ready_for_execution',
    policy,
    connectionVerified: true,
    autoPolicyEnabled: true,
    canAutoExecute: true,
    requiresApproval: false,
    completionClaimAllowed: false,
    completionEvidenceRequired: true,
    requirements,
    blockers: [],
    nextStep: 'Ejecutar mediante el conector real, capturar evidencia y pasar QA.',
    action,
  };
}

function toExternalProposal(task) {
  return {
    id: `proposal:${task.id}`,
    taskId: task.id,
    action: task.action,
    department: task.department,
    title: task.title,
    status: 'proposed',
    reason: task.execution.blockers.join(', '),
    nextStep: task.execution.nextStep,
  };
}

function toApprovalRequest(task) {
  return {
    id: `approval:${task.id}`,
    taskId: task.id,
    action: task.action,
    department: task.department,
    title: task.title,
    status: task.execution.connectionVerified ? 'pending' : 'blocked_pending_connection',
    connectionVerified: task.execution.connectionVerified,
    policy: task.execution.policy,
    requestedDecision: 'approve_or_reject_external_action',
  };
}

function toExecutionRoute(workstream) {
  return {
    id: `route:${workstream.id}`,
    workstreamId: workstream.id,
    owner: workstream.department,
    ownerLabel: workstream.departmentLabel,
    path: [...workstream.route],
    sequence: [
      {
        stage: 'research',
        owner: workstream.department,
        allowedEffect: EFFECT_LEVELS.READ_ONLY,
      },
      {
        stage: 'draft',
        owner: workstream.department,
        allowedEffect: EFFECT_LEVELS.INTERNAL_WRITE,
      },
      {
        stage: 'quality_gate',
        owner: DEPARTMENTS.QUALITY.id,
        allowedEffect: EFFECT_LEVELS.READ_ONLY,
      },
      {
        stage: 'external_effect',
        owner: workstream.department,
        allowedEffect: EFFECT_LEVELS.EXTERNAL_WRITE,
        gate: 'verified_connection_plus_policy',
      },
      {
        stage: 'executive_report',
        owner: 'ceo_office',
        allowedEffect: EFFECT_LEVELS.READ_ONLY,
      },
    ],
  };
}

function summarizePlan(workstreams, externalTasks, proposals, approvalQueue) {
  const counts = {
    research: 0,
    draft: 0,
    externalEffect: 0,
  };
  for (const task of workstreams.flatMap((workstream) => workstream.tasks)) {
    if (task.kind === TASK_KINDS.RESEARCH) counts.research += 1;
    if (task.kind === TASK_KINDS.DRAFT) counts.draft += 1;
    if (task.kind === TASK_KINDS.EXTERNAL_EFFECT) counts.externalEffect += 1;
  }

  return {
    workstreamCount: workstreams.length,
    taskCount: counts.research + counts.draft + counts.externalEffect,
    taskKinds: counts,
    externalActions: {
      total: externalTasks.length,
      readyForExecution: externalTasks.filter((task) => task.status === 'ready_for_execution').length,
      approvalRequired: externalTasks.filter((task) => task.status === 'approval_required').length,
      proposalRequired: externalTasks.filter((task) => task.status === 'proposal_required').length,
      claimedCompleted: 0,
    },
    proposalCount: proposals.length,
    approvalCount: approvalQueue.length,
  };
}

function buildExecutiveSummary(context, workstreams, externalTasks) {
  const top = workstreams.slice(0, 2).map((workstream) => workstream.title.toLowerCase());
  const guardedCount = externalTasks.filter((task) => task.status !== 'ready_for_execution').length;
  const opening = context.companyMode === 'new'
    ? `${context.companyName}: activar primero ${joinSpanish(top)}.`
    : `${context.companyName}: priorizar ${joinSpanish(top)} según las brechas detectadas.`;
  const guardrail = guardedCount
    ? `${guardedCount} acciones externas quedan como propuesta o aprobación hasta verificar conexiones y políticas.`
    : 'Las acciones externas están listas para ejecutarse, pero solo podrán cerrarse con evidencia real.';
  return truncateText(`${opening} ${guardrail}`, MAX_EXECUTIVE_SUMMARY_LENGTH);
}

function validateCompanyAutopilotPlan(plan) {
  const errors = [];
  if (!isPlainObject(plan)) {
    return { ok: false, errors: ['plan_not_object'] };
  }
  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION) errors.push('invalid_schema_version');
  if (!['new', 'existing'].includes(plan.companyMode)) errors.push('invalid_company_mode');
  if (!Array.isArray(plan.workstreams) || plan.workstreams.length !== WORKSTREAM_ORDER.length) {
    errors.push('invalid_workstream_count');
  }
  if (!Array.isArray(plan.executionRoutes) || plan.executionRoutes.length !== WORKSTREAM_ORDER.length) {
    errors.push('invalid_execution_route_count');
  }
  if (typeof plan.executiveSummary !== 'string'
    || !plan.executiveSummary.trim()
    || plan.executiveSummary.length > MAX_EXECUTIVE_SUMMARY_LENGTH) {
    errors.push('invalid_executive_summary');
  } else if (!isSafeNarrative(plan.executiveSummary)) {
    errors.push('unsafe_executive_summary');
  }

  const workstreams = Array.isArray(plan.workstreams) ? plan.workstreams : [];
  const ids = new Set(workstreams.map((workstream) => workstream.id));
  for (const requiredId of WORKSTREAM_ORDER) {
    if (!ids.has(requiredId)) errors.push(`missing_workstream:${requiredId}`);
  }

  let previousScore = Number.POSITIVE_INFINITY;
  for (const workstream of workstreams) {
    if (workstream.score > previousScore) errors.push('workstreams_not_prioritized');
    previousScore = workstream.score;
    if (!Array.isArray(workstream.route)
      || workstream.route[0] !== 'CEO Office'
      || workstream.route.at(-1) !== 'CEO Office') {
      errors.push(`invalid_route:${workstream.id}`);
    }

    for (const task of Array.isArray(workstream.tasks) ? workstream.tasks : []) {
      if (!Object.values(TASK_KINDS).includes(task.kind)) {
        errors.push(`invalid_task_kind:${task.id}`);
      }
      if (task.kind === TASK_KINDS.EXTERNAL_EFFECT) {
        if (task.effect !== EFFECT_LEVELS.EXTERNAL_WRITE) {
          errors.push(`external_task_effect_invalid:${task.id}`);
        }
        if (!['proposal_required', 'approval_required', 'ready_for_execution'].includes(task.status)) {
          errors.push(`external_task_status_invalid:${task.id}`);
        }
        if (task.resultClaim !== 'not_executed') {
          errors.push(`external_task_false_completion:${task.id}`);
        }
        if (task.execution?.completionClaimAllowed !== false) {
          errors.push(`external_completion_claim_allowed:${task.id}`);
        }
        if (task.execution?.completionEvidenceRequired !== true) {
          errors.push(`external_completion_evidence_missing:${task.id}`);
        }
        if (task.execution?.canAutoExecute
          && (!task.execution.connectionVerified || !task.execution.autoPolicyEnabled)) {
          errors.push(`unsafe_auto_execution:${task.id}`);
        }
        if (task.status === 'ready_for_execution'
          && (!task.execution?.connectionVerified
            || !task.execution?.autoPolicyEnabled
            || !task.execution?.canAutoExecute)) {
          errors.push(`unsafe_ready_for_execution:${task.id}`);
        }
        if (task.status !== 'ready_for_execution' && task.execution?.requiresApproval !== true) {
          errors.push(`missing_external_approval_gate:${task.id}`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function buildLlmRequest(plan) {
  return {
    purpose: 'Improve only the executive wording of a deterministic company operating plan.',
    constraints: [
      `executiveSummary must be at most ${MAX_EXECUTIVE_SUMMARY_LENGTH} characters`,
      'Do not claim that publishing, responding, contacting leads or closing sales happened',
      'Do not change task status, policy, connection state, approval or priority',
      'Return JSON with executiveSummary and optional workstreamRationales keyed by workstream id',
    ],
    context: {
      companyMode: plan.companyMode,
      companyName: plan.companyName,
      priorities: plan.priorities,
      readiness: plan.operatingContext.readiness,
    },
    currentNarrative: {
      executiveSummary: plan.executiveSummary,
      workstreamRationales: Object.fromEntries(
        plan.workstreams.map((workstream) => [workstream.id, workstream.rationale])
      ),
    },
  };
}

function resolveLlmInvoker(llm) {
  if (typeof llm === 'function') return llm;
  if (llm && typeof llm.generate === 'function') {
    return (request) => llm.generate(request);
  }
  if (llm && typeof llm.complete === 'function') {
    return (request) => llm.complete(request);
  }
  return null;
}

function parseLlmNarrativePatch(response) {
  const payload = response && isPlainObject(response) && 'text' in response
    ? response.text
    : response;
  if (isPlainObject(payload)) return payload;
  if (typeof payload !== 'string') return null;

  const trimmed = payload.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch (_error) {
    return { executiveSummary: trimmed };
  }
}

function applySafeNarrativePatch(plan, patch) {
  if (!isPlainObject(patch)) return plan;
  let changed = false;
  let executiveSummary = plan.executiveSummary;
  const candidateSummary = cleanText(patch.executiveSummary, MAX_EXECUTIVE_SUMMARY_LENGTH);
  if (candidateSummary && isSafeNarrative(candidateSummary)) {
    executiveSummary = candidateSummary;
    changed = executiveSummary !== plan.executiveSummary;
  }

  const rationales = isPlainObject(patch.workstreamRationales)
    ? patch.workstreamRationales
    : {};
  const workstreams = plan.workstreams.map((workstream) => {
    const candidate = cleanText(rationales[workstream.id], 360);
    if (!candidate || !isSafeNarrative(candidate) || candidate === workstream.rationale) {
      return workstream;
    }
    changed = true;
    return {
      ...workstream,
      rationale: candidate,
    };
  });

  if (!changed) return plan;
  return {
    ...plan,
    executiveSummary,
    workstreams,
  };
}

function isSafeNarrative(text) {
  const normalized = normalizeString(text);
  const falseCompletionPatterns = [
    /\b(publiqué|publicó|publicamos|publicaron|publicado|publicada|published|posted)\b/,
    /\b(envié|envió|enviamos|enviaron|enviado|enviada|sent)\b/,
    /\b(respondí|respondió|respondimos|respondieron|respondido|respondida|replied|answered)\b/,
    /\b(contacté|contactó|contactamos|contactaron|contactado|contactada|contacted)\b/,
    /\b(cerré|cerró|cerramos|cerraron)\s+(?:la\s+)?venta\b/,
    /\b(venta cerrada|ventas cerradas|sale closed|sales closed|sold)\b/,
    /\b(completado|completada|completed|executed successfully|already done)\b/,
  ];
  return !falseCompletionPatterns.some((pattern) => pattern.test(normalized));
}

function inferCompanyMode(profile, readiness) {
  const explicit = normalizeString(readFirst(profile, [
    'companyMode',
    'mode',
    'stage',
    'company.stage',
    'business.stage',
  ]));
  if (['new', 'new_company', 'startup', 'prelaunch', 'idea', 'nueva'].includes(explicit)) {
    return 'new';
  }
  if (['existing', 'operating', 'active', 'established', 'existente'].includes(explicit)) {
    return 'existing';
  }
  if (readFirst(profile, ['isNew', 'newCompany']) === true) return 'new';
  if (readFirst(profile, ['isExisting', 'existingCompany']) === true) return 'existing';

  const existingSignals = [
    readFirst(profile, ['website.url', 'landing.url', 'domain']),
    readFirst(profile, ['customers.count', 'sales.customerCount']),
    readFirst(profile, ['inbox.connected', 'crm.connected']),
    readFirst(readiness, ['operating', 'customers', 'revenue']),
  ];
  return existingSignals.some((value) => (
    hasMeaningfulText(value) || (Number.isFinite(Number(value)) && Number(value) > 0) || isReady(value)
  )) ? 'existing' : 'new';
}

function hasConnection(kind, profile, readiness) {
  const paths = CONNECTION_PATHS[kind] || [];
  return paths.some((path) => (
    isConnected(readFirst(profile, [path]))
    || isConnected(readFirst(readiness, [path]))
  ));
}

function hasConnectedSocialAccount(profile, readiness) {
  const providers = ['facebook', 'linkedin', 'x', 'twitter', 'instagram', 'youtube', 'tiktok'];
  return providers.some((provider) => {
    const paths = [
      `social.${provider}`,
      `socialAccounts.${provider}`,
      `connections.social.${provider}`,
      `integrations.${provider}`,
      `channels.${provider}`,
    ];
    return paths.some((path) => (
      isConnected(readFirst(profile, [path]))
      || isConnected(readFirst(readiness, [path]))
    ));
  });
}

function resolveAutoPolicy(action, profile, readiness) {
  const paths = AUTO_POLICY_PATHS[action] || [];
  for (const source of [profile, readiness]) {
    for (const path of paths) {
      const value = readFirst(source, [path]);
      const policy = normalizeAutoPolicy(value);
      if (policy) return policy;
    }
  }
  return 'approval';
}

function normalizeAutoPolicy(value) {
  if (value === true) return 'auto';
  if (value === false) return 'approval';
  if (isPlainObject(value)) {
    if (value.enabled === false) return 'approval';
    return normalizeAutoPolicy(value.mode ?? value.policy ?? value.auto);
  }
  const normalized = normalizeString(value);
  if (['auto', 'automatic', 'automatico', 'automático', 'autonomous'].includes(normalized)) {
    return 'auto';
  }
  if (['approval', 'manual', 'confirm', 'ask', 'disabled', 'off'].includes(normalized)) {
    return 'approval';
  }
  return null;
}

function isConnected(value) {
  if (value === true) return true;
  if (!value) return false;
  if (isPlainObject(value)) {
    if (value.revoked === true || value.disabled === true || value.simulated === true) return false;
    if (value.connected === true || value.verified === true) return true;
    return isConnected(value.status ?? value.state);
  }
  return ['connected', 'verified', 'active', 'authorized'].includes(normalizeString(value));
}

function isReady(value) {
  if (value === true) return true;
  if (!value) return false;
  if (isPlainObject(value)) {
    if (value.blocked === true || value.missing === true || value.ready === false) return false;
    if (value.ready === true || value.exists === true || value.complete === true || value.configured === true) {
      return true;
    }
    return isReady(value.status ?? value.state);
  }
  return ['ready', 'complete', 'completed', 'configured', 'active', 'available', 'present'].includes(
    normalizeString(value)
  );
}

function percentageReady(values) {
  if (!values.length) return 0;
  return Math.round((values.filter(Boolean).length / values.length) * 100);
}

function countFalse(values) {
  return values.filter((value) => !value).length;
}

function calculateScore({ base, missing, modeBoost, complete }) {
  if (complete) return Math.max(20, Math.min(100, base - 25 + modeBoost));
  return Math.max(20, Math.min(100, base + (missing * 12) + modeBoost));
}

function compareWorkstreams(left, right) {
  if (right.score !== left.score) return right.score - left.score;
  return WORKSTREAM_ORDER.indexOf(left.id) - WORKSTREAM_ORDER.indexOf(right.id);
}

function makePlanId(value) {
  const hash = crypto
    .createHash('sha256')
    .update(stableStringify(value))
    .digest('hex')
    .slice(0, 16);
  return `cap_${hash}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function readFirst(root, paths, fallback = undefined) {
  for (const path of paths) {
    const value = readPath(root, path);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

function readPath(root, path) {
  let current = root;
  for (const segment of String(path).split('.')) {
    if (!isObjectLike(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function isObjectLike(value) {
  return value !== null && typeof value === 'object';
}

function isPlainObject(value) {
  if (!isObjectLike(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasMeaningfulText(value) {
  return typeof value === 'string' && value.trim().length >= 8;
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return truncateText(value.replace(/\s+/g, ' ').trim(), maxLength);
}

function truncateText(value, maxLength) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function joinSpanish(values) {
  if (values.length <= 1) return values[0] || 'las prioridades principales';
  return `${values.slice(0, -1).join(', ')} y ${values.at(-1)}`;
}

module.exports = {
  PLAN_SCHEMA_VERSION,
  TASK_KINDS,
  EFFECT_LEVELS,
  EXTERNAL_ACTIONS,
  DEPARTMENTS,
  buildCompanyAutopilotPlan,
  buildCompanyAutopilotPlanWithLlm,
  createCompanyAutopilotPlan: buildCompanyAutopilotPlanWithLlm,
  planCompanyAutopilot: buildCompanyAutopilotPlan,
  buildOperatingContext,
  resolveExternalExecution,
  validateCompanyAutopilotPlan,
};
