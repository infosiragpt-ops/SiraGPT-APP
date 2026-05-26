'use strict';

const skillsRegistry = require('./skills-registry');

const TOOL_ALIASES = {
  rag_retrieve: 'rag_retrieve',
  llm_reranker: 'llm_reranker',
  nli_faithfulness: 'nli_faithfulness',
  web_search: 'web_search',
  fetch_url: 'web_search',
  deep_document_analyzer: 'deep_analyze',
  document_intelligence: 'docintel_analyze',
  document_comparison: 'compare_documents',
  auto_file_bridge: 'auto_file',
  code_sandbox: 'python_exec',
  git_clone: 'bash_exec',
  repo_inspect: 'bash_exec',
  generate_code: 'python_exec',
  generate_tests: 'python_exec',
  static_check: 'python_exec',
  secret_scan: 'bash_exec',
  dependency_audit: 'bash_exec',
  test_runner: 'python_exec',
  github_actions_monitor: 'bash_exec',
  create_chart: 'create_chart',
  create_dashboard_html: 'create_dashboard_html',
  create_mermaid_diagram: 'create_mermaid_diagram',
  document_renderer: 'create_document',
  generate_image: 'generate_image',
  create_document: 'create_document',
  verify_artifact: 'verify_artifact',
  agent_task_runner: 'agent_task',
  progress_stream: 'agent_task',
  durable_execution_store: 'agent_task',
  active_memory: 'memory_recall',
  session_manager: 'memory_recall',
};

function resolveToolNames(abstractTools) {
  if (!Array.isArray(abstractTools)) return [];
  const resolved = new Set();
  for (const t of abstractTools) {
    const concrete = TOOL_ALIASES[t];
    if (concrete) resolved.add(concrete);
  }
  return [...resolved];
}

function getSkillManifests() {
  const skills = skillsRegistry.listSkills({ limit: 100 });
  const manifests = {};

  for (const skill of skills) {
    const concreteTools = resolveToolNames(skill.tools);
    manifests[`skill_${skill.id}`] = {
      name: `skill_${skill.id}`,
      purpose: `Invoke the "${skill.label}" skill: ${skill.description}`,
      inputs: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'User request or intent text.' },
          context: { type: 'string', description: 'Additional context for the skill.' },
        },
      },
      outputs: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          skillId: { type: 'string' },
          result: { type: 'object' },
        },
      },
      allowed_formats: [],
      forbidden_formats: [],
      expected_errors: [
        { code: 'prerequisite_unmet', description: 'Skill prerequisites not satisfied.', repair_hint: 'Attach required documents or provide needed context.' },
      ],
      acceptance_tests: [`returns ok:true with result for skill ${skill.id}`],
      usage_limits: {
        timeout_ms_default: skill.estimatedCost?.latencyMsP95 || 10000,
        timeout_ms_max: 120000,
        max_calls_per_task: skill.estimatedCost?.toolCalls ? Math.max(skill.estimatedCost.toolCalls, 3) : 5,
        requires_auth: skill.clearance !== 'public',
        requires_network: (skill.sideEffects || []).includes('outbound_http_requests'),
      },
      examples_positive: skill.examples.length > 0
        ? skill.examples.map(e => ({ when: e.when || `invoking ${skill.label}`, call: { query: e.call || 'example' } }))
        : [{ when: `user needs ${skill.label}`, call: { query: `Use ${skill.label} skill` } }],
      examples_negative: [{ when: 'user has a simple question', why: `use conversational_answer instead of ${skill.id}.` }],
      recovery_policy: { on_timeout: 'Return ok:false.', on_error: 'Surface the error.', max_retries: 1 },
      side_effect_level: (skill.sideEffects || []).length > 0 ? 'local-fs' : 'none',
      sandbox_required: false,
      audit_policy: 'every-call',
      scopes: skill.clearance === 'enterprise' ? ['enterprise'] : skill.clearance === 'paid' ? ['paid'] : ['files.read'],
      data_classes: ['internal'],
      _skillMeta: {
        skillId: skill.id,
        category: skill.category,
        clearance: skill.clearance,
        concreteTools,
        prerequisites: skill.prerequisites,
        idempotent: skill.idempotent,
      },
    };
  }

  return manifests;
}

function recommendToolsForIntent(intent, opts = {}) {
  const skills = skillsRegistry.recommendSkills(intent, {
    hasDocuments: opts.hasDocuments,
    hasCode: opts.hasCode,
    needsResearch: opts.needsResearch,
    needsAnalysis: opts.needsAnalysis,
    tags: opts.tags,
    userClearance: opts.userClearance || 'authenticated',
  });

  const toolSet = new Set();
  for (const skill of skills) {
    const concrete = resolveToolNames(skill.tools);
    for (const t of concrete) toolSet.add(t);
  }

  return {
    recommendedSkills: skills.map(s => ({ id: s.id, label: s.label, score: s.score })),
    concreteTools: [...toolSet],
  };
}

module.exports = {
  TOOL_ALIASES,
  resolveToolNames,
  getSkillManifests,
  recommendToolsForIntent,
};
