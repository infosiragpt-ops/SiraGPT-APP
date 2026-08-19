/**
 * enterprise-agentic-runtime
 *
 * Enterprise execution layer built on top of UniversalTaskContract.
 * It compiles the validated user contract into a durable ExecutionGraph
 * with typed nodes, gates, budgets, rollback rules, HITL policy and a
 * MCP-like tool gateway. The graph is metadata + policy; actual tools
 * remain in task-tools.js and are invoked only through their manifests.
 */

const crypto = require('crypto');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ENTERPRISE_RUNTIME_VERSION = 'enterprise-agentic-runtime-2026-04';

const ENTERPRISE_LAYERS = [
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
  'SoftwareEngineeringPipeline',
  'SecurityGovernanceLayer',
  'ValidationFabric',
  'ObservabilityPlane',
  'HumanInTheLoopControlCenter',
];

const NODE_STATES = ['planned', 'waiting', 'running', 'succeeded', 'failed', 'blocked', 'skipped'];
const SIDE_EFFECT_LEVELS = ['none', 'read', 'compute', 'write', 'external'];

const enterpriseToolManifestSchema = {
  $id: 'https://siragpt.io/schemas/enterprise-tool-manifest.v1.json',
  type: 'object',
  additionalProperties: false,
  required: [
    'name',
    'server',
    'purpose',
    'inputs_json_schema',
    'outputs_json_schema',
    'formats_allowed',
    'formats_forbidden',
    'permissions',
    'oauth_scopes',
    'side_effect_level',
    'requires_confirmation',
    'sandbox_required',
    'audit_policy',
    'preconditions',
    'postconditions',
    'limits',
    'examples',
    'expected_errors',
    'recovery_policy',
  ],
  properties: {
    name: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' },
    server: { type: 'string', pattern: '^[a-z][a-z0-9_-]*$' },
    purpose: { type: 'string', minLength: 10, maxLength: 500 },
    inputs_json_schema: { type: 'object', additionalProperties: true },
    outputs_json_schema: { type: 'object', additionalProperties: true },
    formats_allowed: { type: 'array', items: { type: 'string' }, maxItems: 40 },
    formats_forbidden: { type: 'array', items: { type: 'string' }, maxItems: 40 },
    permissions: { type: 'array', items: { type: 'string' }, maxItems: 30 },
    oauth_scopes: { type: 'array', items: { type: 'string' }, maxItems: 30 },
    side_effect_level: { type: 'string', enum: SIDE_EFFECT_LEVELS },
    requires_confirmation: { type: 'boolean' },
    sandbox_required: { type: 'boolean' },
    audit_policy: {
      type: 'object',
      additionalProperties: false,
      required: ['log_inputs', 'log_outputs', 'redact_fields', 'retention_days'],
      properties: {
        log_inputs: { type: 'boolean' },
        log_outputs: { type: 'boolean' },
        redact_fields: { type: 'array', items: { type: 'string' }, maxItems: 30 },
        retention_days: { type: 'integer', minimum: 1, maximum: 3650 },
      },
    },
    preconditions: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    postconditions: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    limits: {
      type: 'object',
      additionalProperties: false,
      required: ['timeout_ms', 'max_calls_per_task', 'rate_limit_policy'],
      properties: {
        timeout_ms: { type: 'integer', minimum: 100, maximum: 7200000 },
        max_calls_per_task: { type: 'integer', minimum: 1, maximum: 10000 },
        rate_limit_policy: { type: 'string', minLength: 3, maxLength: 180 },
      },
    },
    examples: {
      type: 'object',
      additionalProperties: false,
      required: ['positive', 'negative'],
      properties: {
        positive: { type: 'array', items: { type: 'string' }, maxItems: 8 },
        negative: { type: 'array', items: { type: 'string' }, maxItems: 8 },
      },
    },
    expected_errors: { type: 'array', items: { type: 'string' }, maxItems: 30 },
    recovery_policy: { type: 'string', minLength: 10, maxLength: 500 },
  },
};

const enterpriseExecutionGraphSchema = {
  $id: 'https://siragpt.io/schemas/enterprise-execution-graph.v1.json',
  type: 'object',
  additionalProperties: false,
  required: [
    'version',
    'graph_id',
    'root_contract_fingerprint',
    'pipeline',
    'architecture_layers',
    'durable_execution',
    'idempotency_key',
    'cost_budget',
    'latency_budget',
    'nodes',
    'edges',
    'gates',
    'rollback_plan',
    'observability',
    'human_in_the_loop',
    'qa_board',
  ],
  properties: {
    version: { type: 'string', enum: [ENTERPRISE_RUNTIME_VERSION] },
    graph_id: { type: 'string', pattern: '^eg_[a-f0-9]{16}$' },
    root_contract_fingerprint: { type: 'string', pattern: '^[a-f0-9]{16}$' },
    pipeline: { type: 'string' },
    architecture_layers: { type: 'array', items: { type: 'string', enum: ENTERPRISE_LAYERS }, minItems: 1, maxItems: ENTERPRISE_LAYERS.length },
    durable_execution: {
      type: 'object',
      additionalProperties: false,
      required: ['enabled', 'state_store', 'checkpoint_policy', 'resume_strategy', 'replay_policy'],
      properties: {
        enabled: { type: 'boolean' },
        state_store: { type: 'string' },
        checkpoint_policy: { type: 'string' },
        resume_strategy: { type: 'string' },
        replay_policy: { type: 'string' },
      },
    },
    idempotency_key: { type: 'string', pattern: '^idem_[a-f0-9]{20}$' },
    cost_budget: {
      type: 'object',
      additionalProperties: false,
      required: ['max_usd', 'enforcement'],
      properties: {
        max_usd: { type: 'number', minimum: 0 },
        enforcement: { type: 'string', enum: ['warn', 'block'] },
      },
    },
    latency_budget: {
      type: 'object',
      additionalProperties: false,
      required: ['target_ms', 'max_ms'],
      properties: {
        target_ms: { type: 'integer', minimum: 100 },
        max_ms: { type: 'integer', minimum: 100 },
      },
    },
    nodes: {
      type: 'array',
      minItems: 4,
      maxItems: 80,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'layer',
          'agent_role',
          'objective',
          'state',
          'dependencies',
          'inputs',
          'outputs',
          'permissions',
          'tools',
          'rollback',
          'retry_policy',
          'timeout_policy',
          'idempotency_key',
          'cost_budget',
          'latency_budget',
          'validation_gate',
          'release_gate',
        ],
        properties: {
          id: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' },
          layer: { type: 'string', enum: ENTERPRISE_LAYERS },
          agent_role: { type: 'string', minLength: 2, maxLength: 240 },
          objective: { type: 'string', minLength: 8, maxLength: 700 },
          state: { type: 'string', enum: NODE_STATES },
          dependencies: { type: 'array', items: { type: 'string' }, maxItems: 30 },
          inputs: { type: 'array', items: { type: 'string' }, maxItems: 40 },
          outputs: { type: 'array', items: { type: 'string' }, maxItems: 40 },
          permissions: { type: 'array', items: { type: 'string' }, maxItems: 40 },
          tools: { type: 'array', items: { type: 'string' }, maxItems: 40 },
          rollback: {
            type: 'object',
            additionalProperties: false,
            required: ['strategy', 'compensating_actions'],
            properties: {
              strategy: { type: 'string' },
              compensating_actions: { type: 'array', items: { type: 'string' }, maxItems: 20 },
            },
          },
          retry_policy: {
            type: 'object',
            additionalProperties: false,
            required: ['max_attempts', 'backoff', 'retryable_errors'],
            properties: {
              max_attempts: { type: 'integer', minimum: 0, maximum: 10 },
              backoff: { type: 'string' },
              retryable_errors: { type: 'array', items: { type: 'string' }, maxItems: 20 },
            },
          },
          timeout_policy: {
            type: 'object',
            additionalProperties: false,
            required: ['timeout_ms', 'on_timeout'],
            properties: {
              timeout_ms: { type: 'integer', minimum: 100, maximum: 7200000 },
              on_timeout: { type: 'string' },
            },
          },
          idempotency_key: { type: 'string', pattern: '^idem_[a-f0-9]{20}$' },
          cost_budget: { type: 'object', additionalProperties: false, required: ['max_usd'], properties: { max_usd: { type: 'number', minimum: 0 } } },
          latency_budget: { type: 'object', additionalProperties: false, required: ['target_ms', 'max_ms'], properties: { target_ms: { type: 'integer' }, max_ms: { type: 'integer' } } },
          validation_gate: {
            type: 'object',
            additionalProperties: false,
            required: ['required_reports', 'deterministic_checks', 'minimum_score'],
            properties: {
              required_reports: { type: 'array', items: { type: 'string' }, maxItems: 20 },
              deterministic_checks: { type: 'array', items: { type: 'string' }, maxItems: 30 },
              minimum_score: { type: 'integer', minimum: 0, maximum: 100 },
            },
          },
          release_gate: {
            type: 'object',
            additionalProperties: false,
            required: ['requires_release_controller', 'requires_human_confirmation', 'block_on_failed_validation'],
            properties: {
              requires_release_controller: { type: 'boolean' },
              requires_human_confirmation: { type: 'boolean' },
              block_on_failed_validation: { type: 'boolean' },
            },
          },
        },
      },
    },
    edges: {
      type: 'array',
      maxItems: 160,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to', 'condition'],
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          condition: { type: 'string' },
        },
      },
    },
    gates: {
      type: 'object',
      additionalProperties: false,
      required: ['validation_gate', 'release_gate'],
      properties: {
        validation_gate: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 40 },
        release_gate: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 40 },
      },
    },
    rollback_plan: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 40 },
    observability: {
      type: 'object',
      additionalProperties: false,
      required: ['events', 'metrics', 'trace_policy'],
      properties: {
        events: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 80 },
        metrics: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 80 },
        trace_policy: { type: 'string' },
      },
    },
    human_in_the_loop: {
      type: 'object',
      additionalProperties: false,
      required: ['required', 'triggers', 'confirmation_policy'],
      properties: {
        required: { type: 'boolean' },
        triggers: { type: 'array', items: { type: 'string' }, maxItems: 30 },
        confirmation_policy: { type: 'string' },
      },
    },
    qa_board: {
      type: 'object',
      additionalProperties: false,
      required: ['reports_required', 'reviewers', 'release_decision_policy'],
      properties: {
        reports_required: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
        reviewers: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 30 },
        release_decision_policy: { type: 'string' },
      },
    },
  },
};

function manifest({
  name,
  server,
  purpose,
  inputs,
  outputs,
  permissions = [],
  oauthScopes = [],
  sideEffectLevel = 'none',
  requiresConfirmation = false,
  sandboxRequired = false,
  allowed = [],
  forbidden = [],
  preconditions = [],
  postconditions = [],
  timeoutMs = 30000,
  maxCalls = 20,
  positive = [],
  negative = [],
  errors = [],
  recovery,
}) {
  return {
    name,
    server,
    purpose,
    inputs_json_schema: inputs,
    outputs_json_schema: outputs,
    formats_allowed: allowed,
    formats_forbidden: forbidden,
    permissions,
    oauth_scopes: oauthScopes,
    side_effect_level: sideEffectLevel,
    requires_confirmation: requiresConfirmation,
    sandbox_required: sandboxRequired,
    audit_policy: {
      log_inputs: true,
      log_outputs: sideEffectLevel !== 'external',
      redact_fields: ['password', 'token', 'apiKey', 'authorization', 'secret'],
      retention_days: 90,
    },
    preconditions,
    postconditions,
    limits: {
      timeout_ms: timeoutMs,
      max_calls_per_task: maxCalls,
      rate_limit_policy: 'bounded per task with exponential backoff and provider-specific quotas',
    },
    examples: { positive, negative },
    expected_errors: errors,
    recovery_policy: recovery,
  };
}

const ENTERPRISE_TOOL_MANIFESTS = Object.freeze({
  database_query: manifest({
    name: 'database_query',
    server: 'database-connector',
    purpose: 'Run read-only parameterized SQL after schema introspection, query budgeting and permission checks.',
    inputs: { type: 'object', required: ['connection_id', 'sql', 'params'], properties: { connection_id: { type: 'string' }, sql: { type: 'string' }, params: { type: 'array' }, explain: { type: 'boolean' } } },
    outputs: { type: 'object', properties: { ok: { type: 'boolean' }, rows: { type: 'array' }, explain: { type: 'object' }, warnings: { type: 'array' } } },
    permissions: ['db:read', 'db:introspect'],
    sideEffectLevel: 'read',
    preconditions: ['read-only by default', 'prepared statements only', 'query budget must be available'],
    postconditions: ['no mutation statements executed', 'slow query logged when applicable'],
    positive: ['Inspect schema and run SELECT with bound parameters.'],
    negative: ['Run INSERT/UPDATE/DELETE without explicit user confirmation.'],
    errors: ['permission_denied', 'sql_injection_risk', 'query_budget_exceeded', 'slow_query'],
    recovery: 'Rewrite as parameterized read-only SQL, add LIMIT, run EXPLAIN, or ask for explicit write confirmation.',
  }),
  database_write: manifest({
    name: 'database_write',
    server: 'database-connector',
    purpose: 'Execute confirmed database writes through transactions, migrations or ORM with rollback metadata.',
    inputs: { type: 'object', required: ['connection_id', 'operation', 'params', 'confirmation_token'], properties: { connection_id: { type: 'string' }, operation: { type: 'string' }, params: { type: 'object' }, confirmation_token: { type: 'string' } } },
    outputs: { type: 'object', properties: { ok: { type: 'boolean' }, affected_rows: { type: 'integer' }, rollback_ref: { type: 'string' } } },
    permissions: ['db:write'],
    sideEffectLevel: 'write',
    requiresConfirmation: true,
    preconditions: ['explicit confirmation token', 'transaction boundary', 'rollback plan exists'],
    postconditions: ['commit or rollback recorded', 'audit event emitted'],
    positive: ['Apply a confirmed migration with rollback reference.'],
    negative: ['Modify production data from an ambiguous chat request.'],
    errors: ['confirmation_missing', 'migration_failed', 'constraint_violation'],
    recovery: 'Rollback transaction, record FailureReport and require fresh confirmation before retry.',
  }),
  web_crawl: manifest({
    name: 'web_crawl',
    server: 'web-intelligence',
    purpose: 'Run compliant crawling with robots.txt, rate limits, canonicalization, snapshots and provenance.',
    inputs: { type: 'object', required: ['seed_urls'], properties: { seed_urls: { type: 'array', items: { type: 'string', format: 'uri' } }, selectors: { type: 'object' }, max_pages: { type: 'integer' } } },
    outputs: { type: 'object', properties: { ok: { type: 'boolean' }, pages: { type: 'array' }, snapshots: { type: 'array' }, provenance: { type: 'array' } } },
    permissions: ['web:read'],
    sideEffectLevel: 'read',
    sandboxRequired: true,
    preconditions: ['respect robots.txt', 'transparent user-agent', 'no auth bypass', 'no CAPTCHA or paywall circumvention'],
    postconditions: ['HTML snapshots stored with hashes', 'deduplicated canonical URLs'],
    timeoutMs: 120000,
    positive: ['Collect public competitor product pages at a bounded rate.'],
    negative: ['Bypass login, CAPTCHA, paywall or anti-abuse controls.'],
    errors: ['robots_disallowed', 'rate_limited', 'selector_empty', 'blocked_by_terms'],
    recovery: 'Back off, reduce scope, switch to public API or return a compliant gap.',
  }),
  browser_automation: manifest({
    name: 'browser_automation',
    server: 'browser-runtime',
    purpose: 'Automate allowed browser interactions with screenshots, DOM snapshots and explicit confirmation for side effects.',
    inputs: { type: 'object', required: ['steps'], properties: { steps: { type: 'array' }, url: { type: 'string' } } },
    outputs: { type: 'object', properties: { ok: { type: 'boolean' }, screenshots: { type: 'array' }, dom_snapshots: { type: 'array' }, final_url: { type: 'string' } } },
    permissions: ['browser:read', 'browser:interact'],
    sideEffectLevel: 'external',
    requiresConfirmation: true,
    sandboxRequired: true,
    preconditions: ['no credential theft', 'no auth bypass', 'confirmation for purchases/messages/submissions'],
    postconditions: ['visual evidence captured', 'state-changing actions audited'],
    timeoutMs: 180000,
    positive: ['Open a public page and extract visible table data.'],
    negative: ['Submit a reservation without final user confirmation.'],
    errors: ['navigation_timeout', 'selector_not_found', 'confirmation_required'],
    recovery: 'Stop before side effect, ask one confirmation question or provide screenshot evidence of blocker.',
  }),
  code_scaffold: manifest({
    name: 'code_scaffold',
    server: 'software-engineering',
    purpose: 'Create full project structure with architecture, folders, configs, tests and CI according to contract.',
    inputs: { type: 'object', required: ['stack', 'features'], properties: { stack: { type: 'string' }, features: { type: 'array' }, target_dir: { type: 'string' } } },
    outputs: { type: 'object', properties: { ok: { type: 'boolean' }, files: { type: 'array' }, project_type: { type: 'string' } } },
    allowed: ['.ts', '.tsx', '.js', '.py', '.md', '.json', '.yml', 'Dockerfile'],
    permissions: ['fs:write:workspace'],
    sideEffectLevel: 'write',
    sandboxRequired: true,
    preconditions: ['workspace scoped writes only', 'no destructive overwrite without explicit approval'],
    postconditions: ['file list recorded', 'generated project has tests and README'],
    positive: ['Scaffold Next.js App Router SaaS with tests and CI.'],
    negative: ['Overwrite unrelated repo files.'],
    errors: ['path_traversal_blocked', 'file_conflict', 'unsupported_stack'],
    recovery: 'Use a safe subdirectory, emit conflict report and ask before replacing existing files.',
  }),
  ast_analyze: manifest({
    name: 'ast_analyze',
    server: 'software-engineering',
    purpose: 'Inspect generated or existing source code with AST-aware checks for exports, imports, complexity and unsafe patterns.',
    inputs: { type: 'object', required: ['files'], properties: { files: { type: 'array' }, language: { type: 'string' } } },
    outputs: { type: 'object', properties: { ok: { type: 'boolean' }, findings: { type: 'array' }, metrics: { type: 'object' } } },
    permissions: ['fs:read:workspace'],
    sideEffectLevel: 'read',
    sandboxRequired: true,
    preconditions: ['source files exist', 'language parser available or fallback parser selected'],
    postconditions: ['findings mapped to file paths and symbols'],
    positive: ['Detect missing export or unsafe eval usage.'],
    negative: ['Claim code reviewed without parsing or tests.'],
    errors: ['parser_unavailable', 'syntax_error'],
    recovery: 'Fallback to textual static checks and require BuildRunner before release.',
  }),
  build_run: manifest({
    name: 'build_run',
    server: 'software-engineering',
    purpose: 'Run lint, type-check, tests, build and controlled smoke checks inside sandbox.',
    inputs: { type: 'object', required: ['commands'], properties: { commands: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' } } },
    outputs: { type: 'object', properties: { ok: { type: 'boolean' }, command_results: { type: 'array' }, failed_command: { type: 'string' } } },
    permissions: ['process:exec:sandbox'],
    sideEffectLevel: 'compute',
    sandboxRequired: true,
    timeoutMs: 7200000,
    positive: ['Run npm test, tsc and next build before release.'],
    negative: ['Say tests passed without command output.'],
    errors: ['command_failed', 'timeout', 'dependency_missing'],
    recovery: 'Repair failing code, rerun the exact failed command and record evidence.',
  }),
  security_scan: manifest({
    name: 'security_scan',
    server: 'security-governance',
    purpose: 'Run secret scanning, dependency review, SAST/DAST readiness and OWASP ASVS control checks.',
    inputs: { type: 'object', required: ['scope'], properties: { scope: { type: 'string' }, files: { type: 'array' } } },
    outputs: { type: 'object', properties: { ok: { type: 'boolean' }, security_report: { type: 'object' }, blockers: { type: 'array' } } },
    permissions: ['fs:read:workspace', 'security:scan'],
    sideEffectLevel: 'read',
    sandboxRequired: true,
    preconditions: ['secrets redacted from logs', 'no outbound exploit testing without authorization'],
    postconditions: ['SecurityReport includes ASVS category mapping'],
    positive: ['Block a hardcoded API key before commit.'],
    negative: ['Ignore path traversal or SQL injection risk.'],
    errors: ['secret_detected', 'critical_vulnerability', 'scan_tool_unavailable'],
    recovery: 'Remove secret, patch dependency or document unresolved blocker with release rejected.',
  }),
  git_operation: manifest({
    name: 'git_operation',
    server: 'git-runtime',
    purpose: 'Stage, commit, push and inspect repository state with explicit file scope and audit trail.',
    inputs: { type: 'object', required: ['operation'], properties: { operation: { type: 'string' }, files: { type: 'array' }, message: { type: 'string' }, branch: { type: 'string' } } },
    outputs: { type: 'object', properties: { ok: { type: 'boolean' }, sha: { type: 'string' }, branch: { type: 'string' } } },
    permissions: ['git:read', 'git:write'],
    sideEffectLevel: 'write',
    requiresConfirmation: false,
    preconditions: ['do not revert unrelated dirty files', 'stage only intended files'],
    postconditions: ['commit hash or push result recorded'],
    positive: ['Commit only files changed by current task.'],
    negative: ['git reset --hard or checkout unrelated user work.'],
    errors: ['dirty_unrelated_files', 'push_rejected', 'ci_failed'],
    recovery: 'Inspect status, stage intended paths only, fix CI and push a follow-up commit.',
  }),
  deploy_release: manifest({
    name: 'deploy_release',
    server: 'deployment-runtime',
    purpose: 'Deploy approved software through CI/CD with canary/blue-green and rollback policy.',
    inputs: { type: 'object', required: ['target', 'artifact_ref'], properties: { target: { type: 'string' }, artifact_ref: { type: 'string' }, strategy: { type: 'string' } } },
    outputs: { type: 'object', properties: { ok: { type: 'boolean' }, deployment_url: { type: 'string' }, rollback_ref: { type: 'string' } } },
    permissions: ['deploy:write'],
    sideEffectLevel: 'external',
    requiresConfirmation: true,
    preconditions: ['CI green', 'release gate approved', 'rollback plan available'],
    postconditions: ['deployment event and health check recorded'],
    positive: ['Deploy canary after required checks pass.'],
    negative: ['Deploy failing build to production.'],
    errors: ['ci_not_green', 'health_check_failed', 'rollback_failed'],
    recovery: 'Abort or rollback deployment, open FailureReport and keep release blocked.',
  }),
  document_parse: manifest({
    name: 'document_parse',
    server: 'document-intelligence',
    purpose: 'Parse PDF/DOCX/XLSX/PPT with layout, tables, figures, OCR and page-level provenance.',
    inputs: { type: 'object', required: ['file_id'], properties: { file_id: { type: 'string' }, mode: { type: 'string' } } },
    outputs: { type: 'object', properties: { ok: { type: 'boolean' }, chunks: { type: 'array' }, tables: { type: 'array' }, figures: { type: 'array' }, provenance: { type: 'array' } } },
    permissions: ['file:read:owned'],
    sideEffectLevel: 'read',
    sandboxRequired: true,
    preconditions: ['file ownership verified', 'PII redaction policy selected'],
    postconditions: ['chunks include page/table/source references'],
    positive: ['Extract tables from uploaded report with page citations.'],
    negative: ['Summarize a file that was not parsed or retrievable.'],
    errors: ['unsupported_file', 'ocr_failed', 'permission_denied'],
    recovery: 'Fallback to text extraction, mark unavailable sections and avoid unsupported claims.',
  }),
  hybrid_retrieval: manifest({
    name: 'hybrid_retrieval',
    server: 'research-intelligence',
    purpose: 'Run BM25 + embeddings + reranking retrieval over document and research corpora with evidence ledger.',
    inputs: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, collections: { type: 'array' }, k: { type: 'integer' } } },
    outputs: { type: 'object', properties: { ok: { type: 'boolean' }, hits: { type: 'array' }, evidence_ledger: { type: 'array' } } },
    permissions: ['vector:read', 'search:read'],
    sideEffectLevel: 'read',
    preconditions: ['collection access scoped', 'query logged without sensitive data'],
    postconditions: ['evidence ledger contains source ids and scores'],
    positive: ['Find contradictory clauses across uploaded documents.'],
    negative: ['Use retrieved snippets from another user.'],
    errors: ['collection_missing', 'reranker_unavailable'],
    recovery: 'Fallback to BM25, lower k or ask for document upload.',
  }),
  bi_dashboard: manifest({
    name: 'bi_dashboard',
    server: 'bi-studio',
    purpose: 'Create semantic model, star schema, KPIs and dashboard-ready exports from validated data.',
    inputs: { type: 'object', required: ['dataset_ref', 'metrics'], properties: { dataset_ref: { type: 'string' }, metrics: { type: 'array' }, output: { type: 'string' } } },
    outputs: { type: 'object', properties: { ok: { type: 'boolean' }, semantic_model: { type: 'object' }, dashboard_ref: { type: 'string' } } },
    allowed: ['.xlsx', '.pdf', '.pptx', '.html'],
    permissions: ['bi:build'],
    sideEffectLevel: 'compute',
    sandboxRequired: true,
    preconditions: ['input data validated', 'facts/dimensions identified'],
    postconditions: ['KPIs and filters documented', 'export validated'],
    positive: ['Build TAM/SAM/SOM dashboard with facts and dimensions.'],
    negative: ['Invent market numbers without evidence.'],
    errors: ['dataset_invalid', 'metric_undefined'],
    recovery: 'Create data quality report, repair dataset or block release.',
  }),
  design_system_generate: manifest({
    name: 'design_system_generate',
    server: 'design-intelligence',
    purpose: 'Generate design tokens, UI components, responsive layouts and accessibility review.',
    inputs: { type: 'object', required: ['brief'], properties: { brief: { type: 'string' }, brand: { type: 'object' }, output: { type: 'string' } } },
    outputs: { type: 'object', properties: { ok: { type: 'boolean' }, tokens: { type: 'object' }, components: { type: 'array' }, design_review: { type: 'object' } } },
    allowed: ['.svg', '.html', '.tsx', '.pptx'],
    permissions: ['design:build'],
    sideEffectLevel: 'compute',
    sandboxRequired: true,
    preconditions: ['contrast target selected', 'responsive breakpoints defined'],
    postconditions: ['contrast and hierarchy reviewed'],
    positive: ['Generate accessible dashboard design tokens.'],
    negative: ['Deliver visually inconsistent mockups without review.'],
    errors: ['contrast_failed', 'layout_overflow'],
    recovery: 'Adjust tokens/layout, rerun DesignReview and block if contrast remains invalid.',
  }),
});

let toolValidator = null;
let graphValidator = null;

function getToolValidator() {
  if (toolValidator) return toolValidator;
  const ajv = new Ajv({ strict: true, allErrors: true });
  addFormats(ajv);
  toolValidator = ajv.compile(enterpriseToolManifestSchema);
  return toolValidator;
}

function getGraphValidator() {
  if (graphValidator) return graphValidator;
  const ajv = new Ajv({ strict: true, allErrors: true });
  addFormats(ajv);
  graphValidator = ajv.compile(enterpriseExecutionGraphSchema);
  return graphValidator;
}

function validateEnterpriseToolManifest(tool) {
  const validate = getToolValidator();
  const ok = validate(tool);
  return { ok: Boolean(ok), errors: ok ? [] : validate.errors || [] };
}

function validateEnterpriseExecutionGraph(graph) {
  const validate = getGraphValidator();
  const ok = validate(graph);
  const errors = ok ? [] : (validate.errors || []);
  if (!ok) return { ok: false, errors };

  const ids = new Set(graph.nodes.map((node) => node.id));
  const missing = [];
  for (const edge of graph.edges) {
    if (!ids.has(edge.from)) missing.push(`edge.from:${edge.from}`);
    if (!ids.has(edge.to)) missing.push(`edge.to:${edge.to}`);
  }
  for (const node of graph.nodes) {
    for (const dep of node.dependencies) {
      if (!ids.has(dep)) missing.push(`dependency:${node.id}->${dep}`);
    }
  }
  return missing.length ? { ok: false, errors: missing.map((message) => ({ message })) } : { ok: true, errors: [] };
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value || {})).digest('hex').slice(0, 16);
}

function idem(seed) {
  return `idem_${crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 20)}`;
}

function hasAny(text, words) {
  const n = String(text || '').toLowerCase();
  return words.some((word) => n.includes(word));
}

function inferEnterpriseCapabilities(contract = {}) {
  const raw = `${contract.raw_user_request || ''} ${contract.normalized_request || ''}`.toLowerCase();
  const caps = new Set(['ValidationFabric', 'ObservabilityPlane', 'SecurityGovernanceLayer']);

  if (contract.pipeline === 'CodePipeline' || contract.primary_intent === 'code_generation') {
    caps.add('SoftwareEngineeringPipeline');
  }
  if (hasAny(raw, ['next.js', 'nextjs', 'react', 'frontend', 'backend', 'full-stack', 'full stack', 'web', 'saas', 'landing', 'dashboard', 'api'])) {
    caps.add('FullStackWebBuilder');
    caps.add('SoftwareEngineeringPipeline');
    caps.add('DesignSystemGenerator');
  }
  if (contract.pipeline === 'DocumentPipeline' || contract.pipeline === 'SlidePipeline' || contract.pipeline === 'RAGDocumentUnderstandingPipeline' || hasAny(raw, ['pdf', 'docx', 'xlsx', 'pptx', 'ocr', 'documento', 'informe', 'tesis', 'presentacion', 'presentación'])) {
    caps.add('DocumentIntelligenceEngine');
  }
  if (contract.source_requirements?.required || contract.pipeline === 'ResearchGroundingPipeline' || hasAny(raw, ['mercado', 'market', 'competencia', 'tam', 'sam', 'som', 'pestel', 'swot', 'porter', 'scopus', 'openalex'])) {
    caps.add('ResearchMarketIntelligenceEngine');
  }
  if (contract.pipeline === 'SpreadsheetPipeline' || hasAny(raw, ['power bi', 'dashboard', 'kpi', 'dax', 'star schema', 'modelo semantico', 'modelo semántico', 'cohortes', 'funnel'])) {
    caps.add('BusinessIntelligenceStudio');
  }
  if (hasAny(raw, ['sql', 'postgres', 'mysql', 'database', 'base de datos', 'tabla', 'prisma', 'sqlalchemy', 'drizzle', 'typeorm'])) {
    caps.add('DatabaseConnectorLayer');
  }
  if (hasAny(raw, ['scraping', 'scrape', 'crawler', 'crawl', 'playwright', 'scrapy', 'extrae precios', 'competidores', 'browser', 'navegador'])) {
    caps.add('WebAutomationScrapingLayer');
  }
  if (contract.pipeline === 'VisualArtifactPipeline' || contract.pipeline === 'ImagePipeline' || hasAny(raw, ['logo', 'svg', 'mockup', 'wireframe', 'ui kit', 'infografia', 'infografía', 'design system'])) {
    caps.add('DesignSystemGenerator');
  }
  if (contract.pipeline === 'ActionExecutionPipeline') {
    caps.add('ToolRuntime');
    caps.add('HumanInTheLoopControlCenter');
  }
  if ((contract.required_tools || []).length) caps.add('ToolRuntime');

  return Array.from(caps);
}

function toolsForCapability(layer, contract) {
  switch (layer) {
    case 'SoftwareEngineeringPipeline':
      return ['code_scaffold', 'ast_analyze', 'build_run', 'security_scan'];
    case 'FullStackWebBuilder':
      return ['code_scaffold', 'design_system_generate', 'build_run'];
    case 'DatabaseConnectorLayer':
      return ['database_query'];
    case 'WebAutomationScrapingLayer':
      return ['web_crawl', 'browser_automation'];
    case 'DocumentIntelligenceEngine':
      return ['document_parse', 'hybrid_retrieval'];
    case 'ResearchMarketIntelligenceEngine':
      return ['hybrid_retrieval', ...(contract.source_requirements?.required ? ['web_crawl'] : [])];
    case 'BusinessIntelligenceStudio':
      return ['bi_dashboard'];
    case 'DesignSystemGenerator':
      return ['design_system_generate'];
    case 'SecurityGovernanceLayer':
      return ['security_scan'];
    default:
      return [];
  }
}

function permissionsForTools(tools) {
  const permissions = new Set();
  for (const toolName of tools) {
    const tool = ENTERPRISE_TOOL_MANIFESTS[toolName];
    for (const perm of tool?.permissions || []) permissions.add(perm);
  }
  return Array.from(permissions);
}

function requiresHumanConfirmation(tools, contract) {
  if (contract.pipeline === 'ActionExecutionPipeline' || contract.risk_level === 'critical') return true;
  return tools.some((toolName) => ENTERPRISE_TOOL_MANIFESTS[toolName]?.requires_confirmation);
}

function makeNode({
  graphSeed,
  id,
  layer,
  agentRole,
  objective,
  dependencies = [],
  inputs = [],
  outputs = [],
  tools = [],
  contract = {},
  timeoutMs = 60000,
  minimumScore = 90,
}) {
  const human = requiresHumanConfirmation(tools, contract);
  return {
    id,
    layer,
    agent_role: agentRole,
    objective,
    state: 'planned',
    dependencies,
    inputs,
    outputs,
    permissions: permissionsForTools(tools),
    tools,
    rollback: {
      strategy: human ? 'stop-before-side-effect-and-request-confirmation' : 'discard-node-output-and-replay-from-last-checkpoint',
      compensating_actions: human ? ['do_not_execute_external_side_effect_without_user_confirmation'] : ['invalidate_cached_output', 'rerun_node_from_checkpoint'],
    },
    retry_policy: {
      max_attempts: contract.risk_level === 'critical' ? 1 : 3,
      backoff: 'exponential_with_jitter',
      retryable_errors: ['timeout', 'rate_limit', 'transient_tool_error', 'validation_repairable'],
    },
    timeout_policy: {
      timeout_ms: timeoutMs,
      on_timeout: 'persist_checkpoint_emit_failure_report_and_resume_or_repair',
    },
    idempotency_key: idem(`${graphSeed}:${id}`),
    cost_budget: { max_usd: contract.risk_level === 'critical' ? 8 : 3 },
    latency_budget: { target_ms: Math.min(timeoutMs, 30000), max_ms: timeoutMs },
    validation_gate: {
      required_reports: reportsForLayer(layer),
      deterministic_checks: checksForLayer(layer, contract),
      minimum_score: minimumScore,
    },
    release_gate: {
      requires_release_controller: true,
      requires_human_confirmation: human,
      block_on_failed_validation: true,
    },
  };
}

function reportsForLayer(layer) {
  switch (layer) {
    case 'SoftwareEngineeringPipeline':
    case 'FullStackWebBuilder':
      return ['CodeReview', 'SecurityReport', 'PerformanceReport'];
    case 'DocumentIntelligenceEngine':
      return ['ValidationReport', 'FactualityReport'];
    case 'ResearchMarketIntelligenceEngine':
      return ['FactualityReport', 'ValidationReport'];
    case 'DesignSystemGenerator':
      return ['DesignReview', 'ValidationReport'];
    case 'BusinessIntelligenceStudio':
      return ['ValidationReport', 'FactualityReport'];
    case 'DatabaseConnectorLayer':
      return ['SecurityReport', 'ValidationReport'];
    case 'WebAutomationScrapingLayer':
      return ['SecurityReport', 'FactualityReport'];
    case 'SecurityGovernanceLayer':
      return ['SecurityReport'];
    default:
      return ['ValidationReport'];
  }
}

function checksForLayer(layer, contract) {
  const base = ['contract_alignment', 'no_false_success_claim'];
  if (contract.required_extension) base.push(`format:${contract.required_extension}`);
  if (layer === 'DatabaseConnectorLayer') base.push('prepared_statements_only', 'read_only_default');
  if (layer === 'WebAutomationScrapingLayer') base.push('robots_txt_respected', 'no_captcha_paywall_bypass');
  if (layer === 'SoftwareEngineeringPipeline' || layer === 'FullStackWebBuilder') base.push('tests_or_build_executed', 'secrets_absent');
  if (layer === 'ResearchMarketIntelligenceEngine') base.push('evidence_ledger_present', 'source_gaps_labeled');
  if (layer === 'DesignSystemGenerator') base.push('contrast_reviewed', 'responsive_breakpoints_checked');
  return base;
}

function addEdge(edges, from, to, condition = 'dependency succeeded and checkpoint persisted') {
  if (from && to) edges.push({ from, to, condition });
}

function buildEnterpriseExecutionGraph({ contract, taskId = null, userId = null, chatId = null, now = new Date() } = {}) {
  if (!contract || typeof contract !== 'object') {
    throw new Error('contract is required to build enterprise execution graph');
  }
  const fingerprintValue = fingerprint(contract);
  const graphId = `eg_${fingerprintValue}`;
  const graphSeed = `${graphId}:${taskId || 'task'}`;
  const capabilities = inferEnterpriseCapabilities(contract);
  const architectureLayers = Array.from(new Set([
    'AgenticOperatingCore',
    'WorkflowOrchestrator',
    'ToolRuntime',
    ...capabilities,
    'HumanInTheLoopControlCenter',
  ])).filter((layer) => ENTERPRISE_LAYERS.includes(layer));

  const nodes = [];
  const edges = [];
  const pushNode = (node) => {
    nodes.push(node);
    for (const dep of node.dependencies) addEdge(edges, dep, node.id);
  };

  pushNode(makeNode({
    graphSeed,
    id: 'request_intelligence',
    layer: 'AgenticOperatingCore',
    agentRole: 'IntentAnalyst + ConstraintExtractor + AmbiguityJudge',
    objective: 'Compile the user request into a validated UniversalTaskContract and preserve exact format sovereignty.',
    inputs: ['raw_user_request', 'uploaded_file_ids', 'project_context'],
    outputs: ['validated_universal_task_contract'],
    contract,
    timeoutMs: 15000,
    minimumScore: 95,
  }));

  pushNode(makeNode({
    graphSeed,
    id: 'workflow_orchestration',
    layer: 'WorkflowOrchestrator',
    agentRole: 'PlannerAgent + ToolRouter',
    objective: 'Convert the contract into a durable DAG with checkpoints, retries, budgets, rollback and release gates.',
    dependencies: ['request_intelligence'],
    inputs: ['validated_universal_task_contract'],
    outputs: ['execution_graph', 'node_schedule'],
    contract,
    timeoutMs: 20000,
    minimumScore: 95,
  }));

  if ((contract.multi_intent_dag?.nodes || []).length > 1) {
    contract.multi_intent_dag.nodes.forEach((child, index) => {
      const id = `contract_child_${index + 1}`;
      const deps = child.depends_on?.length
        ? child.depends_on.map((dep) => {
          const idx = contract.multi_intent_dag.nodes.findIndex((node) => node.id === dep);
          return idx >= 0 ? `contract_child_${idx + 1}` : 'workflow_orchestration';
        })
        : ['workflow_orchestration'];
      pushNode(makeNode({
        graphSeed,
        id,
        layer: 'WorkflowOrchestrator',
        agentRole: 'MultiIntent DAG Planner',
        objective: `Execute child contract ${child.id} through ${child.pipeline}${child.required_extension ? ` (${child.required_extension})` : ''}.`,
        dependencies: deps,
        inputs: ['parent_contract', child.id],
        outputs: [`child_contract_output:${child.id}`],
        contract,
        timeoutMs: 60000,
        minimumScore: 92,
      }));
    });
  }

  const gatewayTools = (contract.required_tools || []).filter((name) => name !== 'finalize');
  pushNode(makeNode({
    graphSeed,
    id: 'tool_runtime_gateway',
    layer: 'ToolRuntime',
    agentRole: 'MCP Tooling Gateway',
    objective: 'Bind required runtime tools to strict manifests, permissions, scopes, sandbox rules and audit policy.',
    dependencies: ['workflow_orchestration'],
    inputs: ['execution_graph', 'tool_requirements'],
    outputs: ['authorized_tool_manifest_set'],
    tools: gatewayTools,
    contract,
    timeoutMs: 15000,
    minimumScore: 95,
  }));

  let last = 'tool_runtime_gateway';
  for (const layer of capabilities) {
    if (['ToolRuntime', 'ValidationFabric', 'ObservabilityPlane', 'SecurityGovernanceLayer'].includes(layer)) continue;
    const id = layerToNodeId(layer);
    const tools = toolsForCapability(layer, contract);
    pushNode(makeNode({
      graphSeed,
      id,
      layer,
      agentRole: agentRoleForLayer(layer),
      objective: objectiveForLayer(layer, contract),
      dependencies: [last],
      inputs: ['authorized_tool_manifest_set', 'validated_universal_task_contract'],
      outputs: outputsForLayer(layer),
      tools,
      contract,
      timeoutMs: timeoutForLayer(layer),
      minimumScore: layer === 'WebAutomationScrapingLayer' || layer === 'DatabaseConnectorLayer' ? 95 : 90,
    }));
    last = id;
  }

  pushNode(makeNode({
    graphSeed,
    id: 'security_governance',
    layer: 'SecurityGovernanceLayer',
    agentRole: 'Security Governance Agent',
    objective: 'Enforce OWASP ASVS, RBAC/ABAC, secret scanning, path traversal protection and side-effect policy before release.',
    dependencies: [last],
    inputs: ['node_outputs', 'authorized_tool_manifest_set'],
    outputs: ['SecurityReport'],
    tools: ['security_scan'],
    contract,
    timeoutMs: 120000,
    minimumScore: 95,
  }));

  pushNode(makeNode({
    graphSeed,
    id: 'validation_fabric',
    layer: 'ValidationFabric',
    agentRole: 'Validation Fabric + Agentic QA Board',
    objective: 'Run deterministic validation reports for intent, format, sources, code, data, design, performance and artifacts.',
    dependencies: ['security_governance'],
    inputs: ['node_outputs', 'contract_validation_plan'],
    outputs: ['ValidationReport', 'FactualityReport', 'DesignReview', 'CodeReview', 'PerformanceReport'],
    contract,
    timeoutMs: 180000,
    minimumScore: contract.quality_bar?.min_technical_score || 90,
  }));

  pushNode(makeNode({
    graphSeed,
    id: 'observability_plane',
    layer: 'ObservabilityPlane',
    agentRole: 'TelemetryAgent',
    objective: 'Emit OpenTelemetry-style traces, metrics, logs, costs, errors, repair attempts and replay metadata.',
    dependencies: ['validation_fabric'],
    inputs: ['execution_events', 'validation_reports'],
    outputs: ['observability_trace', 'cost_latency_metrics'],
    contract,
    timeoutMs: 10000,
    minimumScore: 90,
  }));

  pushNode(makeNode({
    graphSeed,
    id: 'release_controller',
    layer: 'HumanInTheLoopControlCenter',
    agentRole: 'ReleaseController + Human-in-the-Loop Controller',
    objective: 'Approve final delivery only after validation, security, factuality, design/code review and release gates pass.',
    dependencies: ['observability_plane'],
    inputs: ['validation_reports', 'security_report', 'user_confirmation_state'],
    outputs: ['ReleaseDecision'],
    contract,
    timeoutMs: 15000,
    minimumScore: 95,
  }));

  const graph = {
    version: ENTERPRISE_RUNTIME_VERSION,
    graph_id: graphId,
    root_contract_fingerprint: fingerprintValue,
    pipeline: contract.pipeline || 'unknown',
    architecture_layers: architectureLayers,
    durable_execution: {
      enabled: true,
      state_store: 'agent-task-store-json-plus-chat-message-metadata',
      checkpoint_policy: 'append every graph/node/tool event before and after execution',
      resume_strategy: 'load task snapshot, replay checkpoints and continue from first non-terminal node',
      replay_policy: 'idempotency keys prevent duplicated side effects; read/compute nodes may replay, write/external nodes require confirmation',
    },
    idempotency_key: idem(`${graphId}:root:${userId || 'anon'}:${chatId || 'nochat'}`),
    cost_budget: { max_usd: contract.risk_level === 'critical' ? 12 : contract.artifact_required ? 6 : 2, enforcement: 'warn' },
    latency_budget: { target_ms: 30000, max_ms: 7200000 },
    nodes,
    edges,
    gates: {
      validation_gate: Array.from(new Set(nodes.flatMap((node) => node.validation_gate.deterministic_checks))).slice(0, 40),
      release_gate: [
        'UniversalTaskContract schema valid',
        'ExecutionGraph schema valid',
        'required ToolManifest set authorized',
        'ValidationReport passed',
        'SecurityReport has no blocker',
        'ReleaseController approved',
      ],
    },
    rollback_plan: [
      'Read-only and compute nodes replay from checkpoint.',
      'Artifact nodes discard invalid outputs and regenerate with FailureReport context.',
      'Database writes require transaction rollback reference and explicit confirmation.',
      'External actions stop before side effect unless confirmation token exists.',
      'Deployment nodes require CI green and rollback reference before release.',
    ],
    observability: {
      events: [
        'request_received',
        'contract_created',
        'contract_validated',
        'execution_graph_created',
        'tool_manifest_authorized',
        'node_started',
        'node_checkpointed',
        'node_failed',
        'self_repair_started',
        'validation_report_created',
        'security_report_created',
        'release_decision_created',
        'final_delivery_approved',
      ],
      metrics: [
        'latency_ms_by_node',
        'cost_by_tool',
        'tool_error_rate',
        'format_confusion_rate',
        'self_repair_rate',
        'hallucination_block_rate',
        'release_rejection_rate',
        'human_confirmation_rate',
      ],
      trace_policy: 'OpenTelemetry-compatible span per node/tool with redacted inputs and replayable checkpoint ids.',
    },
    human_in_the_loop: {
      required: contract.pipeline === 'ActionExecutionPipeline' || nodes.some((node) => node.release_gate.requires_human_confirmation),
      triggers: [
        'external_side_effect',
        'database_write',
        'deployment_to_production',
        'ambiguous_high_risk_request',
        'security_blocker',
      ],
      confirmation_policy: 'Ask one concise confirmation question, include target/action/rollback, then execute only after explicit approval.',
    },
    qa_board: buildQaBoard(contract, capabilities),
  };

  const validation = validateEnterpriseExecutionGraph(graph);
  if (!validation.ok) {
    const message = validation.errors.map((error) => error.message || `${error.instancePath} ${error.message}`).join('; ');
    throw new Error(`Enterprise ExecutionGraph validation failed: ${message}`);
  }
  return graph;
}

function layerToNodeId(layer) {
  return {
    SoftwareEngineeringPipeline: 'software_engineering_pipeline',
    FullStackWebBuilder: 'full_stack_web_builder',
    DatabaseConnectorLayer: 'database_intelligence',
    WebAutomationScrapingLayer: 'compliant_web_intelligence',
    DocumentIntelligenceEngine: 'deep_document_intelligence',
    ResearchMarketIntelligenceEngine: 'research_market_intelligence',
    BusinessIntelligenceStudio: 'market_bi_studio',
    DesignSystemGenerator: 'design_intelligence',
  }[layer] || layer.replace(/[A-Z]/g, (m, i) => (i ? '_' : '') + m.toLowerCase());
}

function agentRoleForLayer(layer) {
  return {
    SoftwareEngineeringPipeline: 'ProjectScaffolder + ArchitecturePlanner + CodeGenerator + ASTAnalyzer + TestGenerator + BuildRunner + CodeReviewer + GitAgent',
    FullStackWebBuilder: 'Full-Stack Web Builder',
    DatabaseConnectorLayer: 'Database Intelligence Agent',
    WebAutomationScrapingLayer: 'Compliant Web Intelligence Agent',
    DocumentIntelligenceEngine: 'Deep Research + Document Intelligence Agent',
    ResearchMarketIntelligenceEngine: 'Research & Market Intelligence Agent',
    BusinessIntelligenceStudio: 'Business Intelligence Studio Agent',
    DesignSystemGenerator: 'Design Intelligence Agent',
  }[layer] || layer;
}

function objectiveForLayer(layer, contract) {
  return {
    SoftwareEngineeringPipeline: 'Plan, generate, analyze, test, scan and review production-grade software without destructive workspace changes.',
    FullStackWebBuilder: 'Build professional web products with App Router/SSR/SEO/accessibility/performance/security checks when the contract requires software/web output.',
    DatabaseConnectorLayer: 'Introspect schemas and run parameterized read-only SQL by default; require confirmation for writes.',
    WebAutomationScrapingLayer: 'Collect public web intelligence compliantly with robots.txt, rate limits, snapshots and no auth/paywall/CAPTCHA bypass.',
    DocumentIntelligenceEngine: 'Parse and synthesize files with layout-aware chunks, tables, OCR, citations and page-level provenance.',
    ResearchMarketIntelligenceEngine: 'Ground factual, academic and market claims with evidence ledger, source validation and gap reporting.',
    BusinessIntelligenceStudio: 'Convert validated data into semantic models, KPIs, dashboards and exportable BI artifacts.',
    DesignSystemGenerator: `Generate design systems and visual artifacts while validating contrast, hierarchy, responsive behavior and requested format ${contract.required_extension || 'inline'}.`,
  }[layer] || 'Execute enterprise capability under contract and validation gates.';
}

function outputsForLayer(layer) {
  return {
    SoftwareEngineeringPipeline: ['project_files', 'tests', 'CodeReview'],
    FullStackWebBuilder: ['web_app_artifact', 'accessibility_report', 'performance_report'],
    DatabaseConnectorLayer: ['schema_introspection', 'query_result', 'query_audit'],
    WebAutomationScrapingLayer: ['html_snapshots', 'structured_extracts', 'provenance'],
    DocumentIntelligenceEngine: ['layout_chunks', 'tables', 'figures', 'evidence_ledger'],
    ResearchMarketIntelligenceEngine: ['verified_sources', 'market_findings', 'evidence_ledger'],
    BusinessIntelligenceStudio: ['semantic_model', 'dashboard_spec', 'BIValidationReport'],
    DesignSystemGenerator: ['design_tokens', 'component_specs', 'DesignReview'],
  }[layer] || ['capability_output'];
}

function timeoutForLayer(layer) {
  return {
    SoftwareEngineeringPipeline: 7200000,
    FullStackWebBuilder: 7200000,
    DatabaseConnectorLayer: 120000,
    WebAutomationScrapingLayer: 1800000,
    DocumentIntelligenceEngine: 600000,
    ResearchMarketIntelligenceEngine: 1800000,
    BusinessIntelligenceStudio: 900000,
    DesignSystemGenerator: 600000,
  }[layer] || 120000;
}

function buildQaBoard(contract, capabilities) {
  const reports = new Set(['ValidationReport', 'SecurityReport', 'ReleaseDecision']);
  const reviewers = new Set(['IntentReviewer', 'FormatValidator', 'SecurityReviewer', 'ReleaseController']);
  if (contract.source_requirements?.required || capabilities.includes('ResearchMarketIntelligenceEngine')) {
    reports.add('FactualityReport');
    reviewers.add('SourceVerifier');
  }
  if (capabilities.includes('DesignSystemGenerator') || capabilities.includes('FullStackWebBuilder')) {
    reports.add('DesignReview');
    reviewers.add('DesignReviewer');
  }
  if (capabilities.includes('SoftwareEngineeringPipeline') || capabilities.includes('FullStackWebBuilder')) {
    reports.add('CodeReview');
    reports.add('PerformanceReport');
    reviewers.add('CodeReviewer');
    reviewers.add('PerformanceReviewer');
  }
  if (capabilities.includes('DatabaseConnectorLayer')) reviewers.add('DataGovernanceReviewer');
  if (capabilities.includes('WebAutomationScrapingLayer')) reviewers.add('ComplianceReviewer');
  return {
    reports_required: Array.from(reports),
    reviewers: Array.from(reviewers),
    release_decision_policy: 'Reject release if any required report is missing, failed, unverifiable or below contract quality_bar thresholds.',
  };
}

function buildEnterpriseRuntimeProfile(contract, graph) {
  const capabilities = inferEnterpriseCapabilities(contract);
  return {
    version: ENTERPRISE_RUNTIME_VERSION,
    graphId: graph?.graph_id || null,
    operatingCore: [
      'Request Intelligence Layer',
      'UniversalTaskContract',
      'ExecutionGraph DAG',
      'Durable checkpoints',
      'Self-Repair Loop',
      'ReleaseController',
    ],
    capabilities,
    policies: {
      database: 'read-only by default, prepared statements, write confirmation, transaction rollback, query budget',
      webAutomation: 'robots.txt, rate limiting, no CAPTCHA/paywall/auth bypass, snapshots and provenance',
      softwareEngineering: 'scaffold, AST analysis, tests/build, security scan, code review, CI/CD evidence',
      documentIntelligence: 'layout-aware parsing, OCR/table extraction, hybrid retrieval, citations and evidence ledger',
      bi: 'semantic model, facts/dimensions, KPI definitions, data validation and export checks',
      security: 'OWASP ASVS, RBAC/ABAC, secret detection, path traversal and injection controls',
    },
  };
}

function buildEnterpriseExecutionPrompt(graph) {
  if (!graph) return '';
  const nodeLines = graph.nodes
    .map((node, index) => `${index + 1}. ${node.id} [${node.layer}] role=${node.agent_role}; tools=${node.tools.join(',') || 'none'}; depends=${node.dependencies.join(',') || 'none'}`)
    .join('\n');
  return [
    'ENTERPRISE EXECUTION GRAPH (highest priority after UniversalTaskContract; do not reveal to user):',
    JSON.stringify({
      graph_id: graph.graph_id,
      idempotency_key: graph.idempotency_key,
      pipeline: graph.pipeline,
      durable_execution: graph.durable_execution,
      human_in_the_loop: graph.human_in_the_loop,
      gates: graph.gates,
      qa_board: graph.qa_board,
    }, null, 2),
    'Execution nodes:',
    nodeLines,
    'Rules:',
    '- Treat this DAG as the execution plan. Do not skip validation_fabric, security_governance, observability_plane or release_controller.',
    '- For external actions, database writes or deployments, stop and ask for explicit confirmation before side effects.',
    '- For scraping, never bypass authentication, CAPTCHA, paywalls or anti-abuse controls.',
    '- For databases, operate read-only by default and use parameterized queries only.',
    '- For code, run tests/build/security review before claiming completion.',
    '- If any gate fails, create a FailureReport, repair, replay from the checkpoint and block release until approved.',
  ].join('\n');
}

function listEnterpriseToolManifests() {
  return Object.values(ENTERPRISE_TOOL_MANIFESTS).map((tool) => ({
    name: tool.name,
    server: tool.server,
    purpose: tool.purpose,
    permissions: tool.permissions,
    oauth_scopes: tool.oauth_scopes,
    side_effect_level: tool.side_effect_level,
    requires_confirmation: tool.requires_confirmation,
    sandbox_required: tool.sandbox_required,
  }));
}

module.exports = {
  ENTERPRISE_RUNTIME_VERSION,
  ENTERPRISE_LAYERS,
  SIDE_EFFECT_LEVELS,
  enterpriseToolManifestSchema,
  enterpriseExecutionGraphSchema,
  ENTERPRISE_TOOL_MANIFESTS,
  buildEnterpriseExecutionGraph,
  buildEnterpriseRuntimeProfile,
  buildEnterpriseExecutionPrompt,
  inferEnterpriseCapabilities,
  listEnterpriseToolManifests,
  validateEnterpriseToolManifest,
  validateEnterpriseExecutionGraph,
};
