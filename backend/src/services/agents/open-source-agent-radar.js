'use strict';

const path = require('path');

const { buildOpenClawIntegrationMap } = require('./openclaw-playbook-bridge');
const { buildHermesIntegrationMap } = require('./hermes-playbook-bridge');

const REVIEWED_AT = '2026-07-06';

const PRIORITY_WEIGHT = Object.freeze({
  P0: 4,
  P1: 3,
  P2: 2,
  P3: 1,
});

const OSS_REFERENCES = Object.freeze([
  {
    id: 'openhands-software-agent-sdk',
    name: 'OpenHands Software Agent SDK',
    category: 'autonomous_code_agents',
    license: 'MIT',
    source: {
      homepage: 'https://www.openhands.dev/',
      repository: 'https://github.com/OpenHands/software-agent-sdk',
      evidence: 'SDK for code agents with local or ephemeral workspaces and tools such as terminal, file editor, and task tracker.',
    },
    tags: ['agents', 'workspace', 'sandbox', 'task-tracker', 'code', 'multi-agent', 'enterprise'],
    strongestIdeas: [
      'Agents operate in a real workspace instead of only returning advice.',
      'A task tracker makes planning, execution, and completion observable.',
      'Major refactors can use multiple agents while still producing reviewable output.',
    ],
    siraAdaptations: [
      {
        id: 'agent_workspace_contract',
        priority: 'P0',
        title: 'Workspace-backed agent tasks',
        surfaces: ['backend/src/routes/agent-task.js', 'backend/src/services/agents/task-store.js', 'components/agentic-steps.tsx'],
        contract: 'Every software task must show plan, apply, verify, and final evidence while storing durable events.',
        validation: ['npm run check:orchestration', 'npm run agent:opensource:map -- --json'],
      },
      {
        id: 'ephemeral_execution_boundary',
        priority: 'P1',
        title: 'Ephemeral or bounded execution spaces',
        surfaces: ['backend/src/services/agents/code-sandbox.js', 'backend/src/services/agents/host-bash-tool.js'],
        contract: 'Run generated or imported code only inside an approved workspace boundary with explicit tool policy.',
        validation: ['npm run skill:validate:agents', 'npm run security:validate'],
      },
    ],
    risks: ['Do not vendor external runtime code without a separate license and security review.'],
  },
  {
    id: 'aider',
    name: 'Aider',
    category: 'repo_editing_loops',
    license: 'Apache-2.0',
    source: {
      homepage: 'https://aider.chat/docs/',
      repository: 'https://github.com/aider-ai/aider',
      evidence: 'Terminal pair programmer with codebase map, git integration, linting, and testing loops.',
    },
    tags: ['repo-map', 'git', 'tests', 'lint', 'diff', 'code', 'large-codebase'],
    strongestIdeas: [
      'Map the codebase before editing so changes follow existing structure.',
      'Use git diffs as the review boundary after each edit.',
      'Run lint/tests after modifications and repair failures before finalizing.',
    ],
    siraAdaptations: [
      {
        id: 'repo_map_before_edit',
        priority: 'P0',
        title: 'Repo map before modifications',
        surfaces: ['backend/src/services/agents/repo-retriever.js', 'backend/src/services/agents/host-code-search-tool.js'],
        contract: 'Before code edits, identify owned files, related tests, protected UI surfaces, and risky dependencies.',
        validation: ['npm run agent:opensource:map -- --recommend "repo map tests"', 'git diff --check'],
      },
      {
        id: 'diff_repair_loop',
        priority: 'P0',
        title: 'Diff plus test repair loop',
        surfaces: ['backend/src/services/agents/agent-plan-verify.js', 'backend/src/services/agents/completion-claim-verifier.js'],
        contract: 'Never claim implementation is complete without diff, focused tests, and explicit failure handling.',
        validation: ['npm run check:orchestration', 'npm run test -- --test-name-pattern=chat agentic loop routing source contract'],
      },
    ],
    risks: ['Automatic git commits must remain opt-in for SiraGPT; users need reviewable diffs.'],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    category: 'multi_session_code_agents',
    license: 'verify-before-vendoring',
    source: {
      homepage: 'https://opencode.ai/',
      repository: 'https://github.com/anomalyco/opencode',
      evidence: 'Open source coding agent with terminal, IDE, desktop, LSP, multi-session, provider, and privacy-first cues.',
    },
    tags: ['multi-session', 'lsp', 'privacy', 'providers', 'desktop', 'ide', 'parallel'],
    strongestIdeas: [
      'Multiple agents can work on the same project while keeping sessions visible.',
      'LSP/context loading improves code-aware changes.',
      'Provider flexibility and privacy posture should be first-class product controls.',
    ],
    siraAdaptations: [
      {
        id: 'visible_multi_session_agents',
        priority: 'P1',
        title: 'Visible multi-session project agents',
        surfaces: ['backend/src/services/agents/session-manager.js', 'backend/src/services/agents/sub-agent-orchestrator.js'],
        contract: 'Project agents should have session IDs, status, tool budgets, and resumable traces.',
        validation: ['npm run agent:opensource:map -- --recommend "multi session agents"', 'npm run skill:validate:agents'],
      },
      {
        id: 'provider_privacy_controls',
        priority: 'P1',
        title: 'Provider and privacy controls',
        surfaces: ['backend/src/services/agents/provider-registry.js', 'backend/src/services/ai-product-os/model-router.js'],
        contract: 'Route models by task, privacy, cost, latency, and artifact fidelity instead of one global default.',
        validation: ['npm run agent:opensource:map -- --json', 'npm run security:validate'],
      },
    ],
    risks: ['Do not promise privacy guarantees unless the exact provider path and retention policy are verified.'],
  },
  {
    id: 'langgraph',
    name: 'LangGraph',
    category: 'agent_orchestration',
    license: 'MIT',
    source: {
      homepage: 'https://docs.langchain.com/oss/python/langgraph/overview',
      repository: 'https://github.com/langchain-ai/langgraph',
      evidence: 'Framework for long-running, stateful agents with durable execution, memory, human-in-the-loop, and observability.',
    },
    tags: ['orchestration', 'stateful', 'durable', 'memory', 'human-in-loop', 'observability'],
    strongestIdeas: [
      'Represent agent work as stateful graphs instead of ad hoc chains.',
      'Durable execution should resume after failures.',
      'Human-in-the-loop controls should exist at state boundaries, not after hidden execution.',
    ],
    siraAdaptations: [
      {
        id: 'stateful_agent_graph',
        priority: 'P0',
        title: 'Stateful agent graph contract',
        surfaces: ['backend/src/services/agents/execution-graph.js', 'backend/src/services/agents/execution-graph-runner.js'],
        contract: 'Agent phases should be explicit nodes with resumable state, event logging, and retry policy.',
        validation: ['npm run check:orchestration', 'npm run agent:opensource:map -- --recommend "durable stateful agents"'],
      },
      {
        id: 'human_gate_boundaries',
        priority: 'P2',
        title: 'Human gates for risky actions',
        surfaces: ['backend/src/services/agents/tool-authorization-gate.js', 'backend/src/services/agents/agent-tool-policy.js'],
        contract: 'External, destructive, credentialed, or irreversible actions need explicit approval or a safe fallback.',
        validation: ['npm run skill:validate:agents', 'npm run security:validate'],
      },
    ],
    risks: ['Avoid adding a second orchestration framework if existing SiraGPT graph services can implement the contract.'],
  },
  {
    id: 'dify',
    name: 'Dify',
    category: 'llm_app_platform',
    license: 'verify-before-vendoring',
    source: {
      homepage: 'https://dify.ai/',
      repository: 'https://github.com/langgenius/dify',
      evidence: 'Open-source LLM app platform combining workflow, RAG pipeline, agent capabilities, model management, and observability.',
    },
    tags: ['workflow', 'rag', 'agents', 'model-management', 'observability', 'apps'],
    strongestIdeas: [
      'Treat app workflows, RAG, agents, and model management as one product system.',
      'Observability belongs in the builder and operations path.',
      'Reusable app templates should be production pathways, not isolated demos.',
    ],
    siraAdaptations: [
      {
        id: 'agentic_product_os',
        priority: 'P1',
        title: 'Agentic product OS map',
        surfaces: ['backend/src/services/agents/ai-product-os.js', 'backend/src/services/ai-product-os/model-router.js'],
        contract: 'Expose workflow, RAG, tools, model routing, cost, and deployment as one governed operating model.',
        validation: ['npm run agent:opensource:map -- --recommend "workflow rag observability"', 'npm run security:validate'],
      },
    ],
    risks: ['Workflow UI ideas must pass UI-lock and product review before changing SiraGPT surfaces.'],
  },
  {
    id: 'librechat',
    name: 'LibreChat',
    category: 'chat_platform',
    license: 'verify-before-vendoring',
    source: {
      homepage: 'https://www.librechat.ai/',
      repository: 'https://github.com/danny-avila/LibreChat',
      evidence: 'Self-hosted AI chat platform with providers, agents, MCP, artifacts, code interpreter, custom actions, search, and multi-user auth.',
    },
    tags: ['chat', 'mcp', 'artifacts', 'providers', 'auth', 'actions', 'search'],
    strongestIdeas: [
      'Provider/model switching should feel native in the chat surface.',
      'Artifacts and actions need consistent ownership, permissions, and download behavior.',
      'Conversation search and multi-user controls are core platform features.',
    ],
    siraAdaptations: [
      {
        id: 'artifact_ownership_contract',
        priority: 'P0',
        title: 'Artifact ownership and download contract',
        surfaces: ['backend/src/routes/agent-task.js', 'components/agentic-steps.tsx', 'lib/agent-task-service.ts'],
        contract: 'Every generated file must be owner-scoped, previewable when possible, downloadable, and verified before final answer.',
        validation: ['npm run agent:opensource:map -- --recommend "artifacts downloads chat"', 'npm run security:validate'],
      },
    ],
    risks: ['Chat UI changes must not regress the mobile composer or existing sidebar behavior.'],
  },
  {
    id: 'open-webui',
    name: 'Open WebUI',
    category: 'self_hosted_ai_interface',
    license: 'verify-before-vendoring',
    source: {
      homepage: 'https://docs.openwebui.com/',
      repository: 'https://github.com/open-webui/open-webui',
      evidence: 'Self-hosted, extensible, provider-agnostic AI interface with local/cloud models, tools, knowledge, and RAG.',
    },
    tags: ['self-hosted', 'offline', 'rag', 'tools', 'knowledge', 'local-models', 'provider-agnostic'],
    strongestIdeas: [
      'Local and cloud providers should share one tool and knowledge interface.',
      'Offline/self-hosted mode is a product constraint, not an afterthought.',
      'Tools and knowledge bases should be extensible but permissioned.',
    ],
    siraAdaptations: [
      {
        id: 'provider_agnostic_knowledge_tools',
        priority: 'P2',
        title: 'Provider-agnostic knowledge and tools',
        surfaces: ['backend/src/services/connectors', 'backend/src/services/rag-service.js', 'backend/src/services/agents/tool-manifest.js'],
        contract: 'Knowledge, tools, and model provider selection should be independent but governed by the same access policy.',
        validation: ['npm run agent:opensource:map -- --recommend "offline rag tools"', 'npm run skill:validate:agents'],
      },
    ],
    risks: ['Offline claims must be tested against actual deployed dependencies and configured providers.'],
  },
  {
    id: 'docling',
    name: 'Docling',
    category: 'document_intelligence',
    license: 'MIT',
    source: {
      homepage: 'https://docling-project.github.io/docling/',
      repository: 'https://github.com/docling-project/docling',
      evidence: 'Document processing toolkit for diverse formats, advanced PDF understanding, layout, tables, OCR, and gen-AI integrations.',
    },
    tags: ['documents', 'docx', 'pdf', 'pptx', 'tables', 'ocr', 'layout', 'rag'],
    strongestIdeas: [
      'Convert documents into a rich representation before asking the model to edit or summarize.',
      'Preserve layout, tables, reading order, and OCR evidence as separate facts.',
      'Document tools must expose format fidelity checks, not only extracted text.',
    ],
    siraAdaptations: [
      {
        id: 'source_preserving_doc_pipeline',
        priority: 'P0',
        title: 'Source-preserving document pipeline',
        surfaces: ['backend/src/services/document-pipeline', 'backend/src/services/agents/professional-document-cycle.js'],
        contract: 'When the user uploads DOCX/PDF/PPTX/XLSX and asks for edits, return the edited file in the requested format with verification evidence.',
        validation: ['npm run agent:opensource:map -- --recommend "docx pdf editar documentos"', 'npm run security:validate'],
      },
    ],
    risks: ['Large Office files need streaming/chunked processing and source-preserving edit paths before model text generation.'],
  },
]);

function buildOpenSourceAgentRadar(opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  const projects = OSS_REFERENCES.map((project) => ({
    ...project,
    siraAdaptations: project.siraAdaptations.map((adaptation) => ({ ...adaptation })),
  }));
  const adaptations = projects.flatMap((project) => project.siraAdaptations.map((adaptation) => ({
    ...adaptation,
    project: project.id,
    projectName: project.name,
    category: project.category,
  })));

  return {
    reviewed_at: opts.reviewedAt || REVIEWED_AT,
    source_policy: {
      mode: 'reference_only',
      no_copy_rule: 'Do not copy external repository runtime code into active SiraGPT paths without a separate license, security, and architecture review.',
      license_rule: 'MIT or Apache references are still design inputs first; dependencies need fresh license and advisory validation before installation.',
      ui_rule: 'Protected UI surfaces require explicit product scope and UI-lock verification.',
      secret_rule: 'Never paste or emit repository secrets, tokens, .env values, or private customer data into reports.',
    },
    counts: {
      references: projects.length,
      adaptations: adaptations.length,
      p0_adaptations: adaptations.filter((item) => item.priority === 'P0').length,
      categories: Array.from(new Set(projects.map((project) => project.category))).length,
    },
    references: projects,
    priority_roadmap: adaptations
      .sort(compareAdaptations)
      .map((item) => ({
        id: item.id,
        priority: item.priority,
        title: item.title,
        inspired_by: item.projectName,
        category: item.category,
        contract: item.contract,
        surfaces: item.surfaces,
        validation: item.validation,
      })),
    validation_commands: [
      'npm run agent:opensource:map -- --json',
      'npm run skill:validate:agents',
      'npm run agent:openclaw:map -- --json',
      'npm run agent:hermes:map -- --json',
      'git diff --check',
      'bash scripts/check-secrets.sh',
    ],
    internal_snapshots: buildInternalSnapshotSummary(repoRoot),
  };
}

function recommendOpenSourceUpgrades(query, opts = {}) {
  const matrix = opts.matrix || buildOpenSourceAgentRadar(opts);
  const terms = tokenize(query);
  const generic = terms.length === 0 || terms.some((term) => ['opensource', 'open', 'source', 'mejorar', 'avanzado', 'superior', 'software'].includes(term));

  return matrix.references
    .map((project) => {
      const matchedTerms = scoreProject(project, terms);
      const priorityBoost = Math.max(...project.siraAdaptations.map((item) => PRIORITY_WEIGHT[item.priority] || 0));
      const score = matchedTerms.length * 3 + priorityBoost + (generic ? 2 : 0);
      return {
        project: project.id,
        name: project.name,
        category: project.category,
        score,
        matchedTerms,
        source: project.source,
        adaptations: project.siraAdaptations
          .slice()
          .sort(compareAdaptations)
          .map((adaptation) => ({
            id: adaptation.id,
            priority: adaptation.priority,
            title: adaptation.title,
            contract: adaptation.contract,
            surfaces: adaptation.surfaces,
            validation: adaptation.validation,
          })),
        risks: project.risks,
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, opts.limit || 6);
}

function renderOpenSourceRadarMarkdown(matrix, recommendations = []) {
  const lines = [
    '# SiraGPT Open Source Agent Radar',
    '',
    `Reviewed: ${matrix.reviewed_at}`,
    '',
    '## Source Policy',
    '',
    `- Mode: ${matrix.source_policy.mode}`,
    `- No-copy rule: ${matrix.source_policy.no_copy_rule}`,
    `- License rule: ${matrix.source_policy.license_rule}`,
    `- UI rule: ${matrix.source_policy.ui_rule}`,
    '',
    '## Priority Roadmap',
    '',
  ];

  for (const item of matrix.priority_roadmap.slice(0, 12)) {
    lines.push(`- ${item.priority} ${item.title} (${item.inspired_by})`);
    lines.push(`  - Contract: ${item.contract}`);
    lines.push(`  - Surfaces: ${item.surfaces.join(', ')}`);
  }

  if (recommendations.length > 0) {
    lines.push('', '## Recommendations', '');
    for (const rec of recommendations) {
      lines.push(`- ${rec.name} (${rec.category}) score=${rec.score}`);
      lines.push(`  - Source: ${rec.source.repository || rec.source.homepage}`);
      lines.push(`  - Next: ${rec.adaptations[0]?.title || 'Review adaptation contract'}`);
    }
  }

  lines.push('', '## Validation', '');
  for (const command of matrix.validation_commands) lines.push(`- \`${command}\``);

  return `${lines.join('\n')}\n`;
}

function buildInternalSnapshotSummary(repoRoot) {
  const summary = {};
  try {
    const openclaw = buildOpenClawIntegrationMap({ repoRoot });
    summary.openclaw = {
      available: true,
      repository: openclaw.source.repository,
      commit: openclaw.source.commit,
      skills: openclaw.counts.upstreamSkills,
      siraSkills: openclaw.counts.siraSkills,
      coverage: openclaw.counts.coverage,
    };
  } catch (err) {
    summary.openclaw = { available: false, error: safeErrorCode(err) };
  }

  try {
    const hermes = buildHermesIntegrationMap({ repoRoot });
    summary.hermes = {
      available: true,
      repository: hermes.source.repository,
      commit: hermes.source.commit,
      skills: hermes.counts.upstreamSkills,
      siraSkills: hermes.counts.siraSkills,
      coverage: hermes.counts.coverage,
    };
  } catch (err) {
    summary.hermes = { available: false, error: safeErrorCode(err) };
  }

  summary.repoRoot = path.basename(repoRoot || process.cwd());
  return summary;
}

function compareAdaptations(a, b) {
  const priorityDelta = (PRIORITY_WEIGHT[b.priority] || 0) - (PRIORITY_WEIGHT[a.priority] || 0);
  if (priorityDelta !== 0) return priorityDelta;
  return a.id.localeCompare(b.id);
}

function scoreProject(project, terms) {
  if (!Array.isArray(terms) || terms.length === 0) return [];
  const haystack = [
    project.id,
    project.name,
    project.category,
    project.license,
    project.source?.evidence,
    ...(project.tags || []),
    ...(project.strongestIdeas || []),
    ...(project.risks || []),
    ...(project.siraAdaptations || []).flatMap((adaptation) => [
      adaptation.id,
      adaptation.priority,
      adaptation.title,
      adaptation.contract,
      ...(adaptation.surfaces || []),
      ...(adaptation.validation || []),
    ]),
  ].join(' ').toLowerCase();
  return terms.filter((term) => haystack.includes(term));
}

function tokenize(input) {
  const stopWords = new Set([
    'con',
    'los',
    'las',
    'para',
    'por',
    'que',
    'del',
    'una',
    'uno',
    'the',
    'and',
    'with',
    'from',
    'our',
    'software',
  ]);
  return String(input || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9_-]+/)
    .filter((term) => term.length >= 3 && !stopWords.has(term));
}

function safeErrorCode(err) {
  if (!err) return 'unknown';
  if (err.code) return String(err.code);
  if (err.name) return String(err.name);
  return 'error';
}

module.exports = {
  REVIEWED_AT,
  OSS_REFERENCES,
  buildOpenSourceAgentRadar,
  recommendOpenSourceUpgrades,
  renderOpenSourceRadarMarkdown,
  tokenize,
};
