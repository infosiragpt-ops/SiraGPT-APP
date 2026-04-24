/**
 * ai-product-os
 *
 * Backend-only control plane that turns a UniversalTaskContract and
 * EnterpriseExecutionGraph into an AI Product Operating System envelope.
 * It is intentionally metadata/policy-first: no UI assumptions, no tool
 * execution here, and no free-form model behavior outside typed contracts.
 */

const crypto = require('crypto');

const {
  universalTaskContractSchema,
} = require('./universal-task-contract');
const {
  ENTERPRISE_RUNTIME_VERSION,
  ENTERPRISE_LAYERS,
  enterpriseExecutionGraphSchema,
} = require('./enterprise-agentic-runtime');

const AI_PRODUCT_OS_VERSION = 'ai-product-operating-system-2026-04';

const AI_PRODUCT_OS_COMPONENTS = Object.freeze([
  'AgenticOperatingCore',
  'WorkflowOrchestrator',
  'ToolRuntime',
  'CodeExecutionSandbox',
  'DocumentIntelligenceEngine',
  'ResearchMarketIntelligenceEngine',
  'DatabaseConnectorLayer',
  'WebAutomationScrapingLayer',
  'DesignSystemGenerator',
  'BusinessIntelligenceStudio',
  'FullStackWebBuilder',
  'SecurityGovernanceLayer',
  'ValidationFabric',
  'ObservabilityPlane',
  'HumanInTheLoopControlCenter',
]);

const AGENTIC_KERNEL_AGENTS = Object.freeze([
  'IntentCompilerAgent',
  'ConstraintExtractorAgent',
  'PlannerAgent',
  'ToolRouterAgent',
  'CodeArchitectAgent',
  'DocumentAnalystAgent',
  'ResearchVerifierAgent',
  'DatabaseAgent',
  'ScrapingAgent',
  'BIAnalystAgent',
  'DesignDirectorAgent',
  'FrontendEngineerAgent',
  'BackendEngineerAgent',
  'SecurityReviewerAgent',
  'QARegressionAgent',
  'ReleaseManagerAgent',
  'TelemetryAgent',
]);

const SYSTEM_LAW = Object.freeze({
  do_not_answer_freely: true,
  compile_request_to_contract: true,
  validate_contract_before_execution: true,
  select_tools_only_from_registry: true,
  execute_as_dag: true,
  persist_state: true,
  require_evidence_for_factual_claims: true,
  require_format_sovereignty: true,
  run_deterministic_validators: true,
  repair_before_delivery: true,
  block_release_if_validation_fails: true,
  never_fake_scores: true,
  never_fake_file_reading: true,
  never_fake_citations: true,
  never_fake_artifacts: true,
});

const OBSERVABILITY_EVENTS = Object.freeze([
  'request_received',
  'contract_created',
  'contract_validated',
  'execution_graph_created',
  'ambiguity_detected',
  'tool_selected',
  'artifact_generated',
  'format_validation_passed',
  'semantic_validation_failed',
  'self_repair_started',
  'validation_report_created',
  'security_report_created',
  'factuality_report_created',
  'design_review_created',
  'code_review_created',
  'performance_report_created',
  'release_gate_checked',
  'final_delivery_approved',
]);

function buildAiProductOperatingSystem({
  contract,
  graph,
  toolRuntimePlan = null,
  qaBoardReview = null,
  now = new Date(),
} = {}) {
  if (!contract || typeof contract !== 'object') {
    throw new Error('ai-product-os: contract is required');
  }
  if (!graph || typeof graph !== 'object') {
    throw new Error('ai-product-os: execution graph is required');
  }

  const traceId = makeTraceId(contract, graph);
  const executionGraphSpec = buildExecutionGraphSpec({ contract, graph, toolRuntimePlan, traceId });
  const schemaArtifacts = buildSchemaArtifacts({ contract, executionGraphSpec });
  const runtimeBindings = buildRuntimeBindings({ contract, graph, executionGraphSpec, toolRuntimePlan, traceId });
  const validationFabric = buildValidationFabric({ contract, graph, qaBoardReview });
  const releasePolicy = buildReleasePolicy({ contract, graph, validationFabric, toolRuntimePlan });
  const operatingSystem = {
    version: AI_PRODUCT_OS_VERSION,
    os_id: `aipos_${hash({ contract, graphId: graph.graph_id }).slice(0, 16)}`,
    created_at: now.toISOString(),
    trace_id: traceId,
    correlation_id: graph.idempotency_key || `corr_${hash(contract).slice(0, 20)}`,
    causation_id: contract.contract_id || graph.root_contract_fingerprint || null,
    mission: 'AI Product Operating System: contract-first, DAG-executed, tool-native, observable, validated and self-repairing digital product factory.',
    components: AI_PRODUCT_OS_COMPONENTS,
    system_law: { ...SYSTEM_LAW },
    schema_artifacts: schemaArtifacts,
    universal_task_contract: {
      schema_ref: 'UniversalTaskContract.schema.json',
      contract_id: contract.contract_id || null,
      pipeline: contract.pipeline || null,
      primary_intent: contract.primary_intent || null,
      required_extension: contract.required_extension || null,
      mime_type: contract.mime_type || null,
      artifact_required: Boolean(contract.artifact_required),
      grounding_required: Boolean(contract.grounding_required || contract.source_requirements?.required),
      ambiguity_score: Number(contract.ambiguity_score || 0),
      risk_level: contract.risk_level || 'medium',
      quality_bar: contract.quality_bar || 'professional',
    },
    execution_graph: executionGraphSpec,
    execution_graph_yaml: toYaml(executionGraphSpec),
    agentic_kernel: buildAgenticKernel({ contract, graph, toolRuntimePlan }),
    runtime_bindings: runtimeBindings,
    validation_fabric: validationFabric,
    security_governance: buildSecurityGovernance({ contract, graph }),
    observability_plane: buildObservabilityPlane({ graph, traceId }),
    human_in_the_loop: buildHumanInTheLoop({ contract, graph, toolRuntimePlan }),
    release_policy: releasePolicy,
    evidence_ledger: buildEvidenceLedger({ contract, graph }),
    summary: {
      contractFirst: true,
      dagExecutable: true,
      temporalCompatible: true,
      langGraphCompatible: true,
      mcpToolingGatewayRequired: true,
      openAiAgentsSdkCompatible: true,
      interfaceChanges: false,
      nodeCount: Array.isArray(graph.nodes) ? graph.nodes.length : 0,
      authorizedToolCount: toolRuntimePlan?.summary?.authorizedToolCount || 0,
      validationReportsRequired: validationFabric.required_reports.length,
      releaseBlockedOnFailedValidation: releasePolicy.block_release_if_validation_fails,
    },
  };

  const validation = validateAiProductOperatingSystem(operatingSystem);
  if (!validation.ok) {
    throw new Error(`ai-product-os: invalid operating system: ${validation.errors.join('; ')}`);
  }

  return operatingSystem;
}

function buildExecutionGraphSpec({ contract, graph, toolRuntimePlan, traceId }) {
  const authorizedTools = toolRuntimePlan?.authorization?.authorizedTools || [];
  const allToolCalls = Array.from(new Set([
    ...authorizedTools,
    ...(graph.nodes || []).flatMap((node) => node.tools || []),
  ])).filter(Boolean);
  const permissions = Array.from(new Set((graph.nodes || []).flatMap((node) => node.permissions || [])));
  const artifacts = inferArtifacts(contract);
  const nodes = (graph.nodes || []).map((node) => {
    const nodeArtifactTypes = inferNodeArtifacts({ contract, node });
    return {
      id: node.id,
      layer: node.layer,
      state: node.state || 'planned',
      agent_role: node.agent_role,
      inputs: node.inputs || [],
      outputs: node.outputs || [],
      artifacts: nodeArtifactTypes,
      tool_calls: node.tools || [],
      permissions: node.permissions || [],
      idempotency_key: node.idempotency_key,
      retry_policy: node.retry_policy,
      timeout_policy: node.timeout_policy,
      compensation_action: node.rollback?.compensating_actions || [],
      rollback_strategy: node.rollback?.strategy || 'discard-output-and-replay-from-checkpoint',
      validation_gate: node.validation_gate,
      human_approval_gate: {
        required: Boolean(node.release_gate?.requires_human_confirmation),
        trigger: node.release_gate?.requires_human_confirmation
          ? 'write_external_or_high_risk_side_effect'
          : 'none',
      },
      release_gate: node.release_gate,
      evidence_ledger: {
        required: Boolean(contract.grounding_required || contract.source_requirements?.required || nodeArtifactTypes.length),
        expected_items: expectedEvidenceForNode({ contract, node }),
      },
      audit_trace: {
        trace_id: traceId,
        span_id: makeSpanId(`${graph.graph_id}:${node.id}`),
        event_prefix: `agentic.${node.id}`,
      },
    };
  });

  return {
    kind: 'ExecutionGraph',
    version: ENTERPRISE_RUNTIME_VERSION,
    graph_id: graph.graph_id,
    root_contract_fingerprint: graph.root_contract_fingerprint,
    state: 'planned',
    pipeline: graph.pipeline,
    nodes,
    edges: graph.edges || [],
    inputs: ['UniversalTaskContract.schema.json', 'user_message', 'attachments', 'project_context'],
    outputs: ['validated_artifacts', 'release_decision', 'audit_trace'],
    artifacts,
    tool_calls: allToolCalls,
    permissions,
    idempotency_key: graph.idempotency_key,
    retry_policy: {
      max_attempts: contract.risk_level === 'critical' ? 1 : 3,
      backoff: 'exponential_with_jitter',
      retryable_errors: ['timeout', 'rate_limit', 'transient_tool_error', 'validation_repairable'],
    },
    timeout_policy: {
      timeout_ms: graph.latency_budget?.max_ms || 7200000,
      heartbeat_required: true,
      on_timeout: 'persist_checkpoint_emit_failure_report_and_resume_or_repair',
    },
    compensation_action: ['block_release', 'emit_failure_report', 'rollback_or_replay_safe_nodes'],
    rollback_strategy: graph.rollback_plan || ['resume from last validated checkpoint'],
    validation_gate: {
      deterministic: graph.gates?.validation_gate || [],
      reports_required: graph.qa_board?.reports_required || ['ValidationReport'],
      minimum_score_policy: 'pass/fail gates are authoritative; scores are advisory and must be computed from evidence',
    },
    human_approval_gate: {
      required: Boolean(graph.human_in_the_loop?.required),
      triggers: graph.human_in_the_loop?.triggers || [],
      policy: graph.human_in_the_loop?.confirmation_policy || 'ask once before side effects',
    },
    release_gate: {
      controller_required: true,
      checks: graph.gates?.release_gate || [],
      block_if_validation_fails: true,
      block_if_format_mismatch: Boolean(contract.required_extension),
      block_if_sources_unverified: Boolean(contract.grounding_required || contract.source_requirements?.required),
    },
    evidence_ledger: buildEvidenceLedger({ contract, graph }),
    audit_trace: {
      trace_id: traceId,
      correlation_id: graph.idempotency_key,
      causation_id: contract.contract_id || graph.root_contract_fingerprint,
      immutable_events: OBSERVABILITY_EVENTS,
    },
  };
}

function buildSchemaArtifacts({ contract, executionGraphSpec }) {
  const contractSchemaJson = stableStringify(universalTaskContractSchema);
  const graphSchemaJson = stableStringify(enterpriseExecutionGraphSchema);
  const graphYaml = toYaml(executionGraphSpec);
  return [
    {
      filename: 'UniversalTaskContract.schema.json',
      mime_type: 'application/schema+json',
      sha256: sha256(contractSchemaJson),
      required_fields: universalTaskContractSchema.required || [],
      contract_fingerprint: hash(contract),
    },
    {
      filename: 'ExecutionGraph.schema.json',
      mime_type: 'application/schema+json',
      sha256: sha256(graphSchemaJson),
      required_fields: enterpriseExecutionGraphSchema.required || [],
      contract_fingerprint: hash(executionGraphSpec),
    },
    {
      filename: 'ExecutionGraph.yaml',
      mime_type: 'application/yaml',
      sha256: sha256(graphYaml),
      required_fields: [
        'nodes',
        'edges',
        'state',
        'inputs',
        'outputs',
        'artifacts',
        'tool_calls',
        'permissions',
        'idempotency_key',
        'retry_policy',
        'timeout_policy',
        'compensation_action',
        'rollback_strategy',
        'validation_gate',
        'human_approval_gate',
        'release_gate',
        'evidence_ledger',
        'audit_trace',
      ],
      contract_fingerprint: hash(executionGraphSpec),
    },
  ];
}

function buildAgenticKernel({ contract, graph, toolRuntimePlan }) {
  const handoffs = [
    ['IntentCompilerAgent', 'ConstraintExtractorAgent'],
    ['ConstraintExtractorAgent', 'PlannerAgent'],
    ['PlannerAgent', 'ToolRouterAgent'],
    ['ToolRouterAgent', 'QARegressionAgent'],
    ['QARegressionAgent', 'ReleaseManagerAgent'],
    ['ReleaseManagerAgent', 'TelemetryAgent'],
  ];
  const activeLayers = new Set(graph.architecture_layers || []);
  if (activeLayers.has('SoftwareEngineeringPipeline')) {
    handoffs.push(['PlannerAgent', 'CodeArchitectAgent']);
    handoffs.push(['CodeArchitectAgent', 'FrontendEngineerAgent']);
    handoffs.push(['CodeArchitectAgent', 'BackendEngineerAgent']);
    handoffs.push(['FrontendEngineerAgent', 'QARegressionAgent']);
    handoffs.push(['BackendEngineerAgent', 'QARegressionAgent']);
  }
  if (activeLayers.has('DocumentIntelligenceEngine')) handoffs.push(['DocumentAnalystAgent', 'ResearchVerifierAgent']);
  if (activeLayers.has('DatabaseConnectorLayer')) handoffs.push(['ToolRouterAgent', 'DatabaseAgent']);
  if (activeLayers.has('WebAutomationScrapingLayer')) handoffs.push(['ToolRouterAgent', 'ScrapingAgent']);
  if (activeLayers.has('BusinessIntelligenceStudio')) handoffs.push(['BIAnalystAgent', 'DesignDirectorAgent']);

  return {
    agents: AGENTIC_KERNEL_AGENTS.map((name) => ({
      name,
      status: activeAgentStatus(name, activeLayers, contract),
      structured_io: 'UniversalTaskContract + ExecutionGraph node envelope',
      veto_right: ['SecurityReviewerAgent', 'QARegressionAgent', 'ReleaseManagerAgent'].includes(name),
    })),
    handoffs,
    guardrails: [
      'contract_schema_guardrail',
      'format_sovereignty_guardrail',
      'declared_tool_registry_guardrail',
      'factual_evidence_guardrail',
      'side_effect_confirmation_guardrail',
      'release_gate_guardrail',
    ],
    sessions: {
      persistent: true,
      checkpoint_key: graph.idempotency_key,
      replay_safe: true,
    },
    tool_registry: {
      declared_only: true,
      authorized_tools: toolRuntimePlan?.authorization?.authorizedTools || [],
      blocked_tools: toolRuntimePlan?.authorization?.blockers || [],
    },
  };
}

function buildRuntimeBindings({ contract, graph, executionGraphSpec, toolRuntimePlan, traceId }) {
  const temporalAddressConfigured = Boolean(process.env.TEMPORAL_ADDRESS);
  return {
    temporal: {
      required: true,
      adapter: 'TemporalWorkflowAdapter',
      configured: temporalAddressConfigured,
      namespace: process.env.TEMPORAL_NAMESPACE || 'siragpt',
      task_queue: process.env.TEMPORAL_TASK_QUEUE || 'siragpt-agentic-workflows',
      workflow_type: 'AgenticProductWorkflow',
      workflow_id: graph.graph_id,
      workflow_execution_id: graph.idempotency_key,
      search_attributes: {
        pipeline: contract.pipeline || 'unknown',
        risk_level: contract.risk_level || 'medium',
        required_extension: contract.required_extension || '',
      },
      activity_heartbeat_policy: 'heartbeat every long-running node; fail fast on missed heartbeat beyond timeout_policy',
      retry_policy: executionGraphSpec.retry_policy,
      fallback_store: temporalAddressConfigured ? null : 'durable-execution-store:file-json',
      fallback_reason: temporalAddressConfigured ? null : 'TEMPORAL_ADDRESS is not configured in this runtime; local durable store preserves graph checkpoints.',
    },
    langgraph: {
      required: true,
      adapter: 'LangGraphStateAdapter',
      state_schema_ref: 'ExecutionGraph.yaml',
      checkpoint_namespace: graph.graph_id,
      persistent_state: true,
      nodes: executionGraphSpec.nodes.map((node) => node.id),
      edges: executionGraphSpec.edges.map((edge) => `${edge.from}->${edge.to}`),
      human_in_the_loop: executionGraphSpec.human_approval_gate,
      streaming_events: OBSERVABILITY_EVENTS,
    },
    openai_agents_sdk: {
      compatible: true,
      primitives: ['agents', 'tools', 'handoffs', 'guardrails', 'structured_outputs', 'tracing', 'sessions', 'streaming'],
      structured_output_schema: 'UniversalTaskContract.schema.json',
      agents_as_tools: true,
      sandbox_agents: true,
      trace_id: traceId,
    },
    mcp_gateway: {
      required: true,
      protocol: 'Model Context Protocol compatible gateway',
      declared_tools_only: true,
      resources_enabled: true,
      prompts_enabled: true,
      authorized_tools: toolRuntimePlan?.authorization?.authorizedTools || [],
      blocked_tools: toolRuntimePlan?.authorization?.blockers || [],
      side_effect_policy: toolRuntimePlan?.summary?.sideEffectSummary || {},
    },
    eventing: {
      envelope: {
        trace_id: traceId,
        correlation_id: graph.idempotency_key,
        causation_id: contract.contract_id || graph.root_contract_fingerprint,
        span_id: '<per-node-span>',
        event_name: '<observability-event>',
      },
      transports_supported: ['in_process', 'nats_jetstream', 'kafka'],
      durable_replay_required: true,
    },
  };
}

function buildValidationFabric({ contract, graph, qaBoardReview }) {
  const reports = new Set(graph.qa_board?.reports_required || []);
  for (const node of graph.nodes || []) {
    for (const report of node.validation_gate?.required_reports || []) reports.add(report);
  }
  if (contract.grounding_required || contract.source_requirements?.required) reports.add('FactualityReport');
  if (contract.required_extension) reports.add('ValidationReport');
  return {
    required_reports: Array.from(reports),
    deterministic_validators: Array.from(new Set([
      ...(graph.gates?.validation_gate || []),
      ...(contract.required_extension ? [`format:${contract.required_extension}`] : []),
      ...(contract.grounding_required || contract.source_requirements?.required ? ['evidence_ledger_present'] : []),
    ])),
    qa_board_decision: qaBoardReview?.summary?.decision || 'pending',
    current_blockers: qaBoardReview?.summary?.blockerCount || 0,
    self_repair_loop: {
      required: true,
      failure_report_required: true,
      retry_failed_stage_only: true,
      block_failed_release: true,
    },
  };
}

function buildSecurityGovernance({ contract, graph }) {
  return {
    baseline: 'OWASP ASVS + least privilege + tenant isolation + immutable audit',
    controls: [
      'secret_scanning',
      'dependency_scanning',
      'container_image_scanning',
      'supply_chain_signing',
      'path_traversal_prevention',
      'xss_sanitization',
      'csrf_protection',
      'sqli_prevention',
      'rate_limiting',
      'pii_redaction',
      'rbac_abac_rls',
    ],
    read_only_database_default: (graph.architecture_layers || []).includes('DatabaseConnectorLayer'),
    external_side_effects_require_confirmation: Boolean(graph.human_in_the_loop?.required || contract.pipeline === 'ActionExecutionPipeline'),
    no_bypass_policy: [
      'no_captcha_bypass',
      'no_paywall_bypass',
      'no_authentication_bypass',
      'no_anti_abuse_circumvention',
    ],
  };
}

function buildObservabilityPlane({ graph, traceId }) {
  return {
    vendor_neutral: true,
    framework: 'OpenTelemetry-compatible',
    trace_id: traceId,
    events: OBSERVABILITY_EVENTS,
    metrics: [
      'intent_confusion_matrix',
      'hallucination_rate',
      'tool_failure_rate',
      'validation_pass_rate',
      'self_repair_rate',
      'format_failure_rate',
      'latency_by_stage',
      'cost_attribution',
      'workflow_replay_count',
    ],
    sinks_supported: ['Prometheus', 'Grafana', 'Jaeger', 'Tempo', 'Loki', 'ClickHouse'],
    replay: {
      enabled: true,
      graph_id: graph.graph_id,
      idempotency_key: graph.idempotency_key,
    },
  };
}

function buildHumanInTheLoop({ contract, graph, toolRuntimePlan }) {
  return {
    required: Boolean(graph.human_in_the_loop?.required || toolRuntimePlan?.summary?.requiresHumanConfirmation),
    triggers: graph.human_in_the_loop?.triggers || [],
    confirmation_policy: graph.human_in_the_loop?.confirmation_policy || 'ask once before side effects or ambiguous high-risk execution',
    ambiguous_request_policy: Number(contract.ambiguity_score || 0) >= 0.7 ? 'ask_one_clarifying_question' : 'execute_contract',
  };
}

function buildReleasePolicy({ contract, graph, validationFabric, toolRuntimePlan }) {
  return {
    release_controller_required: true,
    block_release_if_validation_fails: true,
    block_release_if_format_mismatch: Boolean(contract.required_extension),
    block_release_if_unverified_sources: Boolean(contract.grounding_required || contract.source_requirements?.required),
    block_release_if_tool_runtime_blocked: Boolean(toolRuntimePlan?.summary?.blockerCount),
    required_reports: validationFabric.required_reports,
    final_delivery_rules: contract.final_delivery_rules || [],
    decision_states: ['approved', 'blocked', 'repair_required', 'requires_human_approval'],
    graph_release_gate: graph.gates?.release_gate || [],
  };
}

function buildEvidenceLedger({ contract, graph }) {
  return {
    required: Boolean(contract.grounding_required || contract.source_requirements?.required || contract.artifact_required || contract.required_extension),
    source_evidence_required: Boolean(contract.grounding_required || contract.source_requirements?.required),
    artifact_evidence_required: Boolean(contract.artifact_required || contract.required_extension),
    entries_expected: [
      'contract_validation',
      'execution_graph_validation',
      ...(contract.required_extension ? [`format_validation:${contract.required_extension}`] : []),
      ...(contract.grounding_required || contract.source_requirements?.required ? ['citation_grounding', 'source_verification'] : []),
      'release_decision',
    ],
    graph_id: graph.graph_id,
  };
}

function validateAiProductOperatingSystem(os) {
  const errors = [];
  if (!os || typeof os !== 'object') errors.push('os must be an object');
  if (os?.version !== AI_PRODUCT_OS_VERSION) errors.push('version mismatch');
  if (!/^aipos_[a-f0-9]{16}$/.test(os?.os_id || '')) errors.push('os_id must be stable aipos hash');
  if (!/^[a-f0-9]{32}$/.test(os?.trace_id || '')) errors.push('trace_id must be 32 hex chars');
  if (!Array.isArray(os?.components) || os.components.length < AI_PRODUCT_OS_COMPONENTS.length) errors.push('all AI Product OS components are required');
  for (const [key, value] of Object.entries(SYSTEM_LAW)) {
    if (os?.system_law?.[key] !== value) errors.push(`system_law.${key} must be ${value}`);
  }
  if (!Array.isArray(os?.schema_artifacts) || !os.schema_artifacts.some((a) => a.filename === 'UniversalTaskContract.schema.json')) {
    errors.push('UniversalTaskContract.schema.json artifact is required');
  }
  if (!os?.schema_artifacts?.some((a) => a.filename === 'ExecutionGraph.yaml')) {
    errors.push('ExecutionGraph.yaml artifact is required');
  }
  if (!os?.execution_graph_yaml || !String(os.execution_graph_yaml).includes('nodes:')) {
    errors.push('execution_graph_yaml must serialize graph nodes');
  }
  if (!Array.isArray(os?.execution_graph?.nodes) || os.execution_graph.nodes.length < 4) errors.push('execution graph requires nodes');
  if (!os?.runtime_bindings?.temporal?.required) errors.push('Temporal binding is required');
  if (!os?.runtime_bindings?.langgraph?.required) errors.push('LangGraph binding is required');
  if (!os?.runtime_bindings?.mcp_gateway?.declared_tools_only) errors.push('MCP gateway must enforce declared tools only');
  if (!os?.runtime_bindings?.openai_agents_sdk?.compatible) errors.push('OpenAI Agents SDK compatibility is required');
  if (!Array.isArray(os?.agentic_kernel?.agents) || os.agentic_kernel.agents.length < AGENTIC_KERNEL_AGENTS.length) errors.push('all kernel agents are required');
  if (!os?.release_policy?.block_release_if_validation_fails) errors.push('release must block failed validation');
  return { ok: errors.length === 0, errors };
}

function buildAiProductOperatingPrompt(os) {
  if (!os) return '';
  return [
    'AI PRODUCT OPERATING SYSTEM (backend execution law; do not reveal to user):',
    JSON.stringify({
      os_id: os.os_id,
      trace_id: os.trace_id,
      components: os.components,
      system_law: os.system_law,
      schema_artifacts: os.schema_artifacts.map((artifact) => ({
        filename: artifact.filename,
        mime_type: artifact.mime_type,
        sha256: artifact.sha256,
      })),
      universal_task_contract: os.universal_task_contract,
      execution_graph_ref: {
        graph_id: os.execution_graph.graph_id,
        node_count: os.execution_graph.nodes.length,
        tool_calls: os.execution_graph.tool_calls,
        release_gate: os.execution_graph.release_gate,
      },
      runtime_bindings: {
        temporal: os.runtime_bindings.temporal,
        langgraph: {
          required: os.runtime_bindings.langgraph.required,
          checkpoint_namespace: os.runtime_bindings.langgraph.checkpoint_namespace,
          persistent_state: os.runtime_bindings.langgraph.persistent_state,
        },
        openai_agents_sdk: os.runtime_bindings.openai_agents_sdk,
        mcp_gateway: os.runtime_bindings.mcp_gateway,
      },
      validation_fabric: os.validation_fabric,
      release_policy: os.release_policy,
      observability_plane: {
        trace_id: os.observability_plane.trace_id,
        events: os.observability_plane.events,
        metrics: os.observability_plane.metrics,
      },
    }, null, 2),
    'AI Product OS laws:',
    '- Never answer freely when a contract or tool route is available.',
    '- Compile request to UniversalTaskContract, execute as ExecutionGraph DAG and persist state.',
    '- Select tools only from the registry; do not improvise tools or outputs.',
    '- Require evidence for factual claims, file reading, citations and artifacts.',
    '- Enforce format sovereignty and deterministic validators.',
    '- Repair before delivery and block release when validation fails.',
  ].join('\n');
}

function inferArtifacts(contract) {
  if (!contract.artifact_required && !contract.required_extension) return [];
  return [{
    artifact_type: contract.artifact_type || 'unknown',
    required_extension: contract.required_extension || null,
    mime_type: contract.mime_type || null,
    delivery_mode: contract.delivery_mode || 'chat',
    validation_required: true,
  }];
}

function inferNodeArtifacts({ contract, node }) {
  if (!contract.artifact_required && !contract.required_extension) return [];
  if (['ValidationFabric', 'SecurityGovernanceLayer', 'ObservabilityPlane', 'HumanInTheLoopControlCenter'].includes(node.layer)) return [];
  if ((node.outputs || []).some((output) => /artifact|document|dashboard|project|presentation|web_app|design|semantic_model/.test(output))) {
    return inferArtifacts(contract);
  }
  return [];
}

function expectedEvidenceForNode({ contract, node }) {
  const items = ['node_started', 'node_completed_or_failed', 'deterministic_validation'];
  if ((node.tools || []).length) items.push('tool_manifest_authorization');
  if (contract.required_extension) items.push(`format_validation:${contract.required_extension}`);
  if (contract.grounding_required || contract.source_requirements?.required) items.push('source_grounding');
  if (node.release_gate?.requires_human_confirmation) items.push('explicit_human_approval');
  return items;
}

function activeAgentStatus(name, activeLayers, contract) {
  if (['IntentCompilerAgent', 'ConstraintExtractorAgent', 'PlannerAgent', 'ToolRouterAgent', 'SecurityReviewerAgent', 'QARegressionAgent', 'ReleaseManagerAgent', 'TelemetryAgent'].includes(name)) return 'required';
  if (name === 'CodeArchitectAgent' && activeLayers.has('SoftwareEngineeringPipeline')) return 'required';
  if (name === 'DocumentAnalystAgent' && activeLayers.has('DocumentIntelligenceEngine')) return 'required';
  if (name === 'ResearchVerifierAgent' && (activeLayers.has('ResearchMarketIntelligenceEngine') || contract.grounding_required)) return 'required';
  if (name === 'DatabaseAgent' && activeLayers.has('DatabaseConnectorLayer')) return 'required';
  if (name === 'ScrapingAgent' && activeLayers.has('WebAutomationScrapingLayer')) return 'required';
  if (name === 'BIAnalystAgent' && activeLayers.has('BusinessIntelligenceStudio')) return 'required';
  if (name === 'DesignDirectorAgent' && activeLayers.has('DesignSystemGenerator')) return 'required';
  if (name === 'FrontendEngineerAgent' && activeLayers.has('FullStackWebBuilder')) return 'required';
  if (name === 'BackendEngineerAgent' && activeLayers.has('FullStackWebBuilder')) return 'required';
  return 'available';
}

function makeTraceId(contract, graph) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({
      contract: contract?.contract_id || contract?.normalized_request || contract?.raw_user_request || '',
      graph: graph?.graph_id || '',
      idempotency: graph?.idempotency_key || '',
    }))
    .digest('hex')
    .slice(0, 32);
}

function makeSpanId(seed) {
  return crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 16);
}

function hash(value) {
  return crypto.createHash('sha256').update(stableStringify(value || {})).digest('hex');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function stableStringify(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((acc, key) => {
    acc[key] = sortKeys(value[key]);
    return acc;
  }, {});
}

function toYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return value.map((item) => {
      if (item && typeof item === 'object') {
        return `${pad}-\n${toYaml(item, indent + 2)}`;
      }
      return `${pad}- ${formatYamlScalar(item)}`;
    }).join('\n');
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return '{}';
    return entries.map(([key, val]) => {
      if (Array.isArray(val)) {
        return val.length
          ? `${pad}${key}:\n${toYaml(val, indent + 2)}`
          : `${pad}${key}: []`;
      }
      if (val && typeof val === 'object') {
        return `${pad}${key}:\n${toYaml(val, indent + 2)}`;
      }
      return `${pad}${key}: ${formatYamlScalar(val)}`;
    }).join('\n');
  }
  return `${pad}${formatYamlScalar(value)}`;
}

function formatYamlScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const text = String(value);
  if (!text) return '""';
  if (/^[a-zA-Z0-9_./:-]+$/.test(text)) return text;
  return JSON.stringify(text);
}

module.exports = {
  AI_PRODUCT_OS_VERSION,
  AI_PRODUCT_OS_COMPONENTS,
  AGENTIC_KERNEL_AGENTS,
  SYSTEM_LAW,
  OBSERVABILITY_EVENTS,
  buildAiProductOperatingSystem,
  buildAiProductOperatingPrompt,
  validateAiProductOperatingSystem,
  INTERNAL: {
    buildExecutionGraphSpec,
    buildRuntimeBindings,
    toYaml,
  },
};
