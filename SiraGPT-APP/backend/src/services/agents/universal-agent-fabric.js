'use strict';

/**
 * universal-agent-fabric
 *
 * Deterministic 1000-agent capability fabric for SiraGPT's general agentic
 * runtime. The catalog is generated from stable family/specialization
 * definitions so it is large enough to cover broad work without becoming
 * unmaintainable or spawning uncontrolled concurrent processes.
 */

const UNIVERSAL_AGENT_FABRIC_VERSION = 'sira-universal-agent-fabric-2026-06';

const CYCLE_PHASES = Object.freeze([
  'context_intake',
  'memory_context',
  'intent_contract',
  'team_selection',
  'planning_dag',
  'tool_authorization',
  'execution',
  'evidence_capture',
  'validation',
  'self_repair',
  'final_release',
]);

const FAMILY_DEFINITIONS = Object.freeze([
  {
    id: 'intent-context',
    label: 'Intent and context intelligence',
    domains: ['agentic-operating-core', 'human-in-the-loop-control-center'],
    keywords: ['contexto', 'entender', 'usuario', 'intencion', 'intent', 'ambiguedad', 'preferencia'],
    tools: ['memory_retrieve', 'intent_classifier', 'contract_builder'],
    reports: ['ValidationReport'],
  },
  {
    id: 'planning-orchestration',
    label: 'Planning and orchestration',
    domains: ['workflow-orchestrator', 'agentic-operating-core'],
    keywords: ['plan', 'orquesta', 'workflow', 'dag', 'multi paso', 'proceso', 'autonomo', 'ciclo'],
    tools: ['planner', 'execution_graph', 'checkpoint_store'],
    reports: ['ValidationReport', 'PerformanceReport'],
  },
  {
    id: 'software-engineering',
    label: 'Software engineering',
    domains: ['software-engineering-pipeline', 'code-execution-sandbox'],
    keywords: ['programar', 'codigo', 'software', 'sofware', 'backend', 'frontend', 'api', 'repo', 'github'],
    tools: ['repo_read', 'code_edit', 'run_tests', 'secret_scan'],
    reports: ['CodeReview', 'SecurityReport', 'PerformanceReport'],
  },
  {
    id: 'frontend-product',
    label: 'Frontend and product UI',
    domains: ['full-stack-web-builder', 'design-intelligence-layer'],
    keywords: ['interfaz', 'ui', 'ux', 'frontend', 'pantalla', 'web', 'responsive', 'minimalista'],
    tools: ['browser_e2e', 'visual_regression', 'a11y_check'],
    reports: ['DesignReview', 'CodeReview'],
  },
  {
    id: 'backend-platform',
    label: 'Backend platform',
    domains: ['software-engineering-pipeline', 'tool-runtime', 'observability-plane'],
    keywords: ['backend', 'servidor', 'runtime', 'api', 'cola', 'redis', 'prisma', 'health'],
    tools: ['api_probe', 'run_tests', 'health_check', 'log_analyzer'],
    reports: ['ValidationReport', 'PerformanceReport', 'SecurityReport'],
  },
  {
    id: 'database-data',
    label: 'Database and data systems',
    domains: ['database-connector-layer', 'business-intelligence-studio'],
    keywords: ['base de datos', 'sql', 'postgres', 'datos', 'dataset', 'etl', 'schema', 'consulta'],
    tools: ['schema_introspect', 'read_only_sql', 'data_validator'],
    reports: ['ValidationReport', 'SecurityReport'],
  },
  {
    id: 'document-intelligence',
    label: 'Document intelligence',
    domains: ['document-intelligence-engine', 'validation-fabric'],
    keywords: ['documento', 'word', 'docx', 'pdf', 'anexo', 'portada', 'formato', 'archivo'],
    tools: ['docintel_analyze', 'source_preserving_docx_edit', 'verify_artifact'],
    reports: ['ValidationReport', 'FactualityReport'],
  },
  {
    id: 'research-evidence',
    label: 'Research and evidence',
    domains: ['research-market-intelligence-engine', 'web-automation-scraping-layer'],
    keywords: ['investiga', 'fuentes', 'citas', 'paper', 'articulos', 'doi', 'web', 'evidencia'],
    tools: ['web_search', 'source_verifier', 'citation_validator'],
    reports: ['FactualityReport', 'ValidationReport'],
  },
  {
    id: 'web-automation',
    label: 'Web automation',
    domains: ['web-automation-scraping-layer', 'tool-runtime'],
    keywords: ['clic', 'browser', 'captura', 'playwright', 'navega', 'sube', 'descarga', 'prueba real'],
    tools: ['browser_e2e', 'screenshot_capture', 'dom_inspector'],
    reports: ['ValidationReport', 'SecurityReport'],
  },
  {
    id: 'design-media',
    label: 'Design and media',
    domains: ['design-intelligence-layer', 'full-stack-web-builder'],
    keywords: ['diseño', 'imagen', 'video', 'marca', 'visual', 'presentacion', 'figma', 'estetico'],
    tools: ['design_review', 'image_generation', 'media_validator'],
    reports: ['DesignReview', 'ValidationReport'],
  },
  {
    id: 'qa-validation',
    label: 'QA and validation',
    domains: ['validation-fabric', 'software-engineering-pipeline'],
    keywords: ['prueba', 'test', 'validar', 'comprobar', 'qa', 'e2e', 'resultado', 'calidad'],
    tools: ['run_tests', 'e2e_probe', 'artifact_validator'],
    reports: ['ValidationReport', 'CodeReview'],
  },
  {
    id: 'security-governance',
    label: 'Security and governance',
    domains: ['security-governance-layer', 'tool-runtime'],
    keywords: ['seguridad', 'secretos', 'permiso', 'riesgo', 'politica', 'privacidad', 'auditoria'],
    tools: ['secret_scan', 'policy_guard', 'permission_check'],
    reports: ['SecurityReport'],
  },
  {
    id: 'devops-release',
    label: 'DevOps and release',
    domains: ['software-engineering-pipeline', 'observability-plane'],
    keywords: ['deploy', 'github', 'ci', 'main', 'verde', 'docker', 'release', 'produccion'],
    tools: ['git_status', 'ci_watch', 'docker_build', 'release_gate'],
    reports: ['ValidationReport', 'PerformanceReport'],
  },
  {
    id: 'observability-ops',
    label: 'Observability and operations',
    domains: ['observability-plane', 'workflow-orchestrator'],
    keywords: ['logs', 'metricas', 'monitor', 'traza', 'debug', 'estado', 'health', 'telemetria'],
    tools: ['log_analyzer', 'metrics_probe', 'trace_recorder'],
    reports: ['PerformanceReport', 'ValidationReport'],
  },
  {
    id: 'business-bi',
    label: 'Business intelligence',
    domains: ['business-intelligence-studio', 'database-connector-layer'],
    keywords: ['negocio', 'kpi', 'dashboard', 'excel', 'finanzas', 'matriz', 'comparativa', 'bi'],
    tools: ['spreadsheet_generator', 'kpi_validator', 'chart_builder'],
    reports: ['ValidationReport', 'DesignReview'],
  },
  {
    id: 'math-science',
    label: 'Math and science reasoning',
    domains: ['business-intelligence-studio', 'validation-fabric'],
    keywords: ['calcula', 'estadistica', 'matematica', 'cronbach', 'anova', 'formula', 'modelo'],
    tools: ['python_exec', 'numeric_validator', 'latex_renderer'],
    reports: ['ValidationReport', 'FactualityReport'],
  },
  {
    id: 'communication-writing',
    label: 'Communication and writing',
    domains: ['document-intelligence-engine', 'research-market-intelligence-engine'],
    keywords: ['redacta', 'resumen', 'correo', 'mensaje', 'tono', 'informe', 'conclusiones'],
    tools: ['style_reviewer', 'document_builder', 'citation_validator'],
    reports: ['FactualityReport', 'ValidationReport'],
  },
  {
    id: 'desktop-control',
    label: 'Desktop and local control',
    domains: ['tool-runtime', 'human-in-the-loop-control-center'],
    keywords: ['computadora', 'terminal', 'local', 'mac', 'abrir', 'carpeta', 'desktop'],
    tools: ['desktop_action_policy', 'local_process_probe', 'approval_gate'],
    reports: ['SecurityReport', 'ValidationReport'],
  },
  {
    id: 'memory-personalization',
    label: 'Memory and personalization',
    domains: ['observability-plane', 'agentic-operating-core'],
    keywords: ['usuario', 'preferencias', 'memoria', 'contexto', 'historial', 'personaliza'],
    tools: ['memory_retrieve', 'preference_resolver', 'context_compactor'],
    reports: ['ValidationReport'],
  },
  {
    id: 'safety-ethics',
    label: 'Safety and ethics',
    domains: ['security-governance-layer', 'human-in-the-loop-control-center'],
    keywords: ['etica', 'legal', 'cumplimiento', 'bloquear', 'confirmacion', 'riesgo', 'safe'],
    tools: ['policy_guard', 'risk_classifier', 'approval_gate'],
    reports: ['SecurityReport', 'ValidationReport'],
  },
]);

const SPECIALIZATIONS = Object.freeze([
  ['context-mapper', 'Context Mapper', ['contexto', 'historial'], ['context_intake', 'memory_context']],
  ['intent-analyst', 'Intent Analyst', ['intencion', 'objetivo'], ['context_intake', 'intent_contract']],
  ['constraint-extractor', 'Constraint Extractor', ['restriccion', 'formato'], ['intent_contract']],
  ['ambiguity-resolver', 'Ambiguity Resolver', ['ambiguedad', 'duda'], ['intent_contract', 'team_selection']],
  ['user-preference-keeper', 'User Preference Keeper', ['preferencia', 'usuario'], ['memory_context', 'final_release']],
  ['scope-guard', 'Scope Guard', ['alcance', 'scope'], ['intent_contract', 'final_release']],
  ['risk-triager', 'Risk Triager', ['riesgo', 'critico'], ['intent_contract', 'tool_authorization']],
  ['dag-planner', 'DAG Planner', ['plan', 'dag'], ['planning_dag']],
  ['dependency-mapper', 'Dependency Mapper', ['dependencia', 'orden'], ['planning_dag']],
  ['parallel-lane-planner', 'Parallel Lane Planner', ['paralelo', 'multi agente'], ['planning_dag', 'team_selection']],
  ['tool-router', 'Tool Router', ['herramienta', 'tool'], ['tool_authorization', 'execution']],
  ['permission-guard', 'Permission Guard', ['permiso', 'auth'], ['tool_authorization']],
  ['sandbox-runner', 'Sandbox Runner', ['sandbox', 'ejecutar'], ['tool_authorization', 'execution']],
  ['executor', 'Executor', ['hacer', 'implementar'], ['execution']],
  ['artifact-builder', 'Artifact Builder', ['archivo', 'artefacto'], ['execution', 'evidence_capture']],
  ['source-grounder', 'Source Grounder', ['fuente', 'evidencia'], ['evidence_capture']],
  ['provenance-ledger', 'Provenance Ledger', ['provenance', 'cita'], ['evidence_capture']],
  ['validator', 'Validator', ['validar', 'comprobar'], ['validation']],
  ['qa-reviewer', 'QA Reviewer', ['qa', 'calidad'], ['validation']],
  ['self-repairer', 'Self Repairer', ['reparar', 'corregir'], ['self_repair']],
  ['regression-writer', 'Regression Writer', ['regresion', 'test'], ['self_repair', 'validation']],
  ['release-controller', 'Release Controller', ['entregar', 'final'], ['final_release']],
  ['audit-logger', 'Audit Logger', ['auditoria', 'log'], ['evidence_capture', 'final_release']],
  ['performance-budgeter', 'Performance Budgeter', ['latencia', 'costo'], ['planning_dag', 'validation']],
  ['security-reviewer', 'Security Reviewer', ['seguridad', 'secretos'], ['tool_authorization', 'validation']],
  ['format-sovereignty-keeper', 'Format Sovereignty Keeper', ['word', 'pdf', 'excel', 'formato'], ['intent_contract', 'validation']],
  ['data-normalizer', 'Data Normalizer', ['datos', 'tabla'], ['execution', 'validation']],
  ['document-preserver', 'Document Preserver', ['docx', 'formato'], ['execution', 'validation']],
  ['code-architect', 'Code Architect', ['arquitectura', 'codigo'], ['planning_dag', 'execution']],
  ['test-runner', 'Test Runner', ['test', 'prueba'], ['execution', 'validation']],
  ['browser-prober', 'Browser Prober', ['browser', 'clic'], ['execution', 'evidence_capture']],
  ['screenshot-capturer', 'Screenshot Capturer', ['captura', 'preview'], ['evidence_capture', 'validation']],
  ['ci-watcher', 'CI Watcher', ['ci', 'github'], ['validation', 'final_release']],
  ['deployment-guard', 'Deployment Guard', ['deploy', 'produccion'], ['tool_authorization', 'final_release']],
  ['database-safety-guard', 'Database Safety Guard', ['sql', 'base de datos'], ['tool_authorization', 'validation']],
  ['research-synthesizer', 'Research Synthesizer', ['investiga', 'paper'], ['execution', 'evidence_capture']],
  ['citation-checker', 'Citation Checker', ['cita', 'doi'], ['evidence_capture', 'validation']],
  ['numeric-verifier', 'Numeric Verifier', ['calculo', 'estadistica'], ['execution', 'validation']],
  ['design-reviewer', 'Design Reviewer', ['diseño', 'visual'], ['validation']],
  ['accessibility-reviewer', 'Accessibility Reviewer', ['accesibilidad', 'contraste'], ['validation']],
  ['content-polisher', 'Content Polisher', ['redaccion', 'tono'], ['execution', 'final_release']],
  ['conversation-repairer', 'Conversation Repairer', ['no entendio', 'corrige'], ['memory_context', 'self_repair']],
  ['tool-error-handler', 'Tool Error Handler', ['error', 'fallo'], ['self_repair']],
  ['fallback-strategist', 'Fallback Strategist', ['fallback', 'degradar'], ['self_repair', 'final_release']],
  ['deadline-controller', 'Deadline Controller', ['tiempo', 'timeout'], ['planning_dag', 'validation']],
  ['batch-coordinator', 'Batch Coordinator', ['batch', 'muchos'], ['planning_dag', 'execution']],
  ['quality-gate-owner', 'Quality Gate Owner', ['gate', 'calidad'], ['validation', 'final_release']],
  ['truthfulness-sentinel', 'Truthfulness Sentinel', ['verdad', 'alucinacion'], ['evidence_capture', 'validation']],
  ['human-approval-coordinator', 'Human Approval Coordinator', ['confirmar', 'aprobar'], ['tool_authorization', 'final_release']],
  ['completion-evidence-checker', 'Completion Evidence Checker', ['completo', 'terminado'], ['validation', 'final_release']],
]);

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function slug(value) {
  return normalizeText(value).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function unique(items) {
  return Array.from(new Set((items || []).filter(Boolean)));
}

function makeAgent(family, specialization, familyIndex, specializationIndex) {
  const [specializationId, specializationLabel, specializationKeywords, phases] = specialization;
  const index = (familyIndex * SPECIALIZATIONS.length) + specializationIndex + 1;
  const id = `uagent-${String(index).padStart(4, '0')}-${family.id}-${specializationId}`;
  const role = `${family.label} ${specializationLabel}`;
  const validationChecks = unique([
    `universal_agent.${family.id}.${specializationId}`,
    ...phases.map((phase) => `cycle.${phase}`),
  ]);
  return Object.freeze({
    id,
    family: family.id,
    family_label: family.label,
    specialization: specializationId,
    name: role,
    role,
    index,
    trigger_keywords: unique([...(family.keywords || []), ...(specializationKeywords || [])].map(slug)),
    domains: family.domains || [],
    tools: family.tools || [],
    reports: family.reports || [],
    cycle_phases: phases,
    output_contract: {
      evidence_required: unique(['execution_trace', 'validation_result', ...phases.map((phase) => `phase:${phase}`)]),
      completion_rule: 'Do not mark done until assigned phase evidence and validation checks pass.',
    },
    validation_checks: validationChecks,
    risk_controls: unique(['no_false_success_claim', 'declared_tools_only', 'release_after_validation']),
  });
}

const UNIVERSAL_AGENT_CATALOG = Object.freeze(FAMILY_DEFINITIONS.flatMap((family, familyIndex) => (
  SPECIALIZATIONS.map((specialization, specializationIndex) => makeAgent(family, specialization, familyIndex, specializationIndex))
)));

function rawTextFrom({ goal = '', contract = {}, graph = {} } = {}) {
  return [
    goal,
    contract.raw_user_request,
    contract.rawUserRequest,
    contract.normalized_request,
    contract.normalizedRequest,
    contract.primary_intent,
    contract.pipeline,
    contract.required_extension,
    Array.isArray(graph?.architecture_layers) ? graph.architecture_layers.join(' ') : '',
  ].filter(Boolean).join(' ');
}

function detectUniversalAgentRequest(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return /\b(1000|mil)\b.{0,80}\bagentes?\b/.test(normalized)
    || /\bagentes?\b.{0,80}\b(1000|mil)\b/.test(normalized)
    || /\bciclo\s+agentico\b/.test(normalized)
    || /\b(agentic|autonom[oa]|orquestad[oa]s?)\b.{0,100}\b(todo|general|cualquier|perfect[oa]|contexto|usuario)\b/.test(normalized)
    || /\b(todo|general|cualquier|contexto|usuario)\b.{0,100}\b(agentic|autonom[oa]|orquestad[oa]s?|agentes?)\b/.test(normalized);
}

function domainIdsFrom({ domains = [], graph = {} } = {}) {
  const ids = new Set();
  for (const domain of Array.isArray(domains) ? domains : []) {
    if (domain?.id) ids.add(domain.id);
    if (domain?.layer) ids.add(domain.layer);
  }
  for (const layer of Array.isArray(graph?.architecture_layers) ? graph.architecture_layers : []) ids.add(layer);
  return ids;
}

function scoreAgent(agent, normalizedText, domainIds, broadRequest) {
  let score = broadRequest ? 2 : 0;
  if ((agent.domains || []).some((domain) => domainIds.has(domain))) score += 8;
  for (const keyword of agent.trigger_keywords || []) {
    if (keyword && normalizedText.includes(keyword)) score += 3;
  }
  if (['intent-context', 'planning-orchestration', 'qa-validation', 'security-governance', 'observability-ops'].includes(agent.family)) {
    score += 2;
  }
  if ((agent.cycle_phases || []).includes('final_release')) score += 1;
  return score;
}

function summarizeAgent(agent) {
  return {
    id: agent.id,
    family: agent.family,
    specialization: agent.specialization,
    name: agent.name,
    role: agent.role,
    domains: agent.domains,
    tools: agent.tools,
    reports: agent.reports,
    cycle_phases: agent.cycle_phases,
    validation_checks: agent.validation_checks,
    evidence_required: agent.output_contract.evidence_required,
  };
}

function selectUniversalAgentTeam({ goal = '', contract = {}, graph = {}, domains = [], maxActive = 40 } = {}) {
  const rawText = rawTextFrom({ goal, contract, graph });
  const normalized = normalizeText(rawText);
  const broadRequest = detectUniversalAgentRequest(rawText);
  const domainIds = domainIdsFrom({ domains, graph });
  const requestedMax = Math.min(80, Number(maxActive) || 40);
  const broadMinimum = broadRequest ? (FAMILY_DEFINITIONS.length * 2) + 12 : 12;
  const maxTeamSize = Math.max(broadMinimum, requestedMax);

  const scored = UNIVERSAL_AGENT_CATALOG
    .map((agent) => ({ agent, score: scoreAgent(agent, normalized, domainIds, broadRequest) }))
    .sort((a, b) => b.score - a.score || a.agent.index - b.agent.index);

  const selected = [];
  const selectedIds = new Set();
  const add = (agent) => {
    if (!agent || selectedIds.has(agent.id) || selected.length >= maxTeamSize) return;
    selected.push(agent);
    selectedIds.add(agent.id);
  };

  const mandatorySpecializations = [
    'context-mapper',
    'intent-analyst',
    'ambiguity-resolver',
    'dag-planner',
    'tool-router',
    'executor',
    'source-grounder',
    'validator',
    'self-repairer',
    'release-controller',
    'truthfulness-sentinel',
    'completion-evidence-checker',
  ];
  for (const specialization of mandatorySpecializations) {
    add(scored.find((item) => item.agent.specialization === specialization)?.agent);
  }

  if (broadRequest) {
    for (const family of FAMILY_DEFINITIONS) {
      add(scored.find((item) => item.agent.family === family.id && !selectedIds.has(item.agent.id))?.agent);
      add(scored.find((item) => item.agent.family === family.id && item.agent.specialization === 'validator')?.agent);
    }
  }

  for (const item of scored) {
    if (item.score <= 0 && selected.length >= 16 && !broadRequest) continue;
    add(item.agent);
  }

  const coveredPhases = new Set(selected.flatMap((agent) => agent.cycle_phases || []));
  for (const phase of CYCLE_PHASES) {
    if (coveredPhases.has(phase)) continue;
    add(scored.find((item) => (item.agent.cycle_phases || []).includes(phase))?.agent);
    coveredPhases.add(phase);
  }

  return selected.map(summarizeAgent);
}

function buildCycle(activeTeam) {
  return CYCLE_PHASES.map((phase, index) => {
    const assigned = activeTeam
      .filter((agent) => (agent.cycle_phases || []).includes(phase))
      .slice(0, 6)
      .map((agent) => agent.id);
    return {
      phase,
      order: index + 1,
      assigned_agents: assigned,
      gate: `universal_agents.${phase}.evidence_and_validation_required`,
      done_rule: 'advance only after evidence is recorded, blockers are classified, and repair has run if needed',
    };
  });
}

function buildUniversalAgentFabric({ goal = '', contract = {}, graph = {}, domains = [], maxActive = 40 } = {}) {
  const activeTeam = selectUniversalAgentTeam({ goal, contract, graph, domains, maxActive });
  const activeFamilies = unique(activeTeam.map((agent) => agent.family));
  const cycle = buildCycle(activeTeam);
  const coveredPhases = unique(activeTeam.flatMap((agent) => agent.cycle_phases || []));
  const broadRequest = detectUniversalAgentRequest(rawTextFrom({ goal, contract, graph }));

  return Object.freeze({
    version: UNIVERSAL_AGENT_FABRIC_VERSION,
    mode: broadRequest ? 'universal_1000_agent_fabric' : 'contextual_agent_team',
    summary: {
      totalAgentCount: UNIVERSAL_AGENT_CATALOG.length,
      familyCount: FAMILY_DEFINITIONS.length,
      specializationCount: SPECIALIZATIONS.length,
      activeAgentCount: activeTeam.length,
      activeFamilyCount: activeFamilies.length,
      cyclePhaseCount: CYCLE_PHASES.length,
      coveredCyclePhaseCount: coveredPhases.length,
      universalAgentRequest: broadRequest,
      allCyclePhasesCovered: coveredPhases.length === CYCLE_PHASES.length,
    },
    catalog_summary: FAMILY_DEFINITIONS.map((family) => ({
      family: family.id,
      label: family.label,
      agentCount: SPECIALIZATIONS.length,
      active: activeFamilies.includes(family.id),
      domains: family.domains,
    })),
    active_families: activeFamilies,
    active_team: activeTeam,
    cycle,
    validation_checks: unique([
      'universal_agents.catalog_1000',
      'universal_agents.team_selected',
      'universal_agents.all_cycle_phases_covered',
      'universal_agents.context_understood_before_execution',
      'universal_agents.release_not_before_validation',
      ...activeTeam.flatMap((agent) => agent.validation_checks || []),
      ...cycle.map((phase) => phase.gate),
    ]),
    metrics: unique([
      'universal_agent_catalog_count',
      'universal_agent_active_team_count',
      'universal_agent_cycle_phase_coverage',
      'universal_agent_validation_pass_rate',
      'universal_agent_repair_loop_rate',
    ]),
    operating_rules: [
      'Use the 1000-agent catalog as a specialization pool, not as uncontrolled parallel process spawning.',
      'Select a bounded active team per task from context, user intent, domains, tools and risk.',
      'Every task must move through context, contract, planning, tool authorization, execution, evidence, validation, repair and release.',
      'No final success claim is allowed until validation and completion evidence pass.',
    ],
  });
}

function buildUniversalAgentFabricPrompt(fabric) {
  if (!fabric) return '';
  return [
    'UNIVERSAL AGENT FABRIC (1000-agent specialization pool; do not reveal raw catalog to user):',
    JSON.stringify({
      version: fabric.version,
      mode: fabric.mode,
      summary: fabric.summary,
      active_families: fabric.active_families,
      active_team: (fabric.active_team || []).slice(0, 40).map((agent) => ({
        id: agent.id,
        family: agent.family,
        specialization: agent.specialization,
        role: agent.role,
        phases: agent.cycle_phases,
        tools: agent.tools,
        checks: agent.validation_checks,
      })),
      cycle: fabric.cycle,
      validation_checks: (fabric.validation_checks || []).slice(0, 80),
      metrics: fabric.metrics,
    }, null, 2),
    'Universal agent rules:',
    '- Understand user context and constraints before execution.',
    '- Select the smallest active team that covers every required phase.',
    '- Execute with tools and evidence, validate, self-repair, then release.',
    '- Never claim completion without passing the release gate.',
  ].join('\n');
}

function validateUniversalAgentCatalog(catalog = UNIVERSAL_AGENT_CATALOG) {
  const errors = [];
  if (!Array.isArray(catalog)) errors.push('catalog must be an array');
  const list = Array.isArray(catalog) ? catalog : [];
  if (list.length !== 1000) errors.push(`catalog must contain exactly 1000 agents, got ${list.length}`);
  const ids = new Set();
  const families = new Map();
  const coveredPhases = new Set();
  for (const agent of list) {
    if (!agent || typeof agent !== 'object') {
      errors.push('agent must be an object');
      continue;
    }
    if (!/^uagent-\d{4}-[a-z0-9-]+-[a-z0-9-]+$/.test(agent.id || '')) errors.push(`${agent.id || '<missing>'} has invalid id`);
    if (ids.has(agent.id)) errors.push(`${agent.id} duplicated`);
    ids.add(agent.id);
    if (!agent.family || !agent.specialization || !agent.role) errors.push(`${agent.id} missing family/specialization/role`);
    if (!Array.isArray(agent.cycle_phases) || agent.cycle_phases.length === 0) errors.push(`${agent.id} missing cycle phases`);
    for (const phase of agent.cycle_phases || []) coveredPhases.add(phase);
    if (!Array.isArray(agent.validation_checks) || agent.validation_checks.length === 0) errors.push(`${agent.id} missing validation checks`);
    families.set(agent.family, (families.get(agent.family) || 0) + 1);
  }
  if (ids.size !== list.length) errors.push('agent ids must be unique');
  if (families.size !== FAMILY_DEFINITIONS.length) errors.push(`catalog must contain ${FAMILY_DEFINITIONS.length} families, got ${families.size}`);
  for (const family of FAMILY_DEFINITIONS) {
    const count = families.get(family.id) || 0;
    if (count !== SPECIALIZATIONS.length) errors.push(`${family.id} must contain ${SPECIALIZATIONS.length} agents, got ${count}`);
  }
  for (const phase of CYCLE_PHASES) {
    if (!coveredPhases.has(phase)) errors.push(`catalog does not cover cycle phase ${phase}`);
  }
  return {
    ok: errors.length === 0,
    errors,
    total: list.length,
    families: Object.fromEntries(families),
    coveredPhases: Array.from(coveredPhases),
  };
}

module.exports = {
  UNIVERSAL_AGENT_FABRIC_VERSION,
  CYCLE_PHASES,
  FAMILY_DEFINITIONS,
  SPECIALIZATIONS,
  UNIVERSAL_AGENT_CATALOG,
  buildUniversalAgentFabric,
  buildUniversalAgentFabricPrompt,
  detectUniversalAgentRequest,
  selectUniversalAgentTeam,
  validateUniversalAgentCatalog,
};
