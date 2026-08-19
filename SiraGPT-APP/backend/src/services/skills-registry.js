'use strict';

const crypto = require('crypto');

const SKILL_DIR = Object.freeze({
  information: 'information',
  document: 'document',
  generation: 'generation',
  analysis: 'analysis',
  agentic: 'agentic',
  conversational: 'conversational',
  code: 'code',
  research: 'research',
  data: 'data',
});

const registry = new Map();
const categoryIndex = new Map();
const tagIndex = new Map();

let nextOrder = 1;

function registerSkill(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') throw new Error('descriptor required');
  if (!descriptor.id || typeof descriptor.id !== 'string') throw new Error('descriptor.id required');

  const existing = registry.get(descriptor.id);
  if (existing && !descriptor.overwrite) {
    return existing;
  }

  const skill = {
    id: descriptor.id,
    label: descriptor.label || descriptor.id,
    category: descriptor.category || 'conversational',
    description: descriptor.description || '',
    tools: Array.isArray(descriptor.tools) ? [...descriptor.tools] : [],
    prerequisites: Array.isArray(descriptor.prerequisites) ? [...descriptor.prerequisites] : [],
    sideEffects: Array.isArray(descriptor.sideEffects) ? [...descriptor.sideEffects] : [],
    idempotent: descriptor.idempotent !== false,
    acceptance: descriptor.acceptance || '',
    estimatedCost: {
      llmCalls: descriptor.estimatedCost?.llmCalls ?? 1,
      toolCalls: descriptor.estimatedCost?.toolCalls ?? 0,
      latencyMsP95: descriptor.estimatedCost?.latencyMsP95 ?? 3000,
    },
    clearance: descriptor.clearance || 'authenticated',
    failureRecovery: descriptor.failureRecovery || '',
    outputKind: descriptor.outputKind || 'text',
    tags: Array.isArray(descriptor.tags) ? [...descriptor.tags] : [],
    examples: Array.isArray(descriptor.examples) ? [...descriptor.examples] : [],
    version: descriptor.version || '1.0.0',
    author: descriptor.author || 'system',
    order: nextOrder++,
    registeredAt: Date.now(),
    metadata: descriptor.metadata || {},
  };

  registry.set(skill.id, skill);

  if (!categoryIndex.has(skill.category)) categoryIndex.set(skill.category, new Set());
  categoryIndex.get(skill.category).add(skill.id);

  for (const tag of skill.tags) {
    if (!tagIndex.has(tag)) tagIndex.set(tag, new Set());
    tagIndex.get(tag).add(skill.id);
  }

  return skill;
}

function unregisterSkill(id) {
  const skill = registry.get(id);
  if (!skill) return false;

  const catSet = categoryIndex.get(skill.category);
  if (catSet) {
    catSet.delete(id);
    if (catSet.size === 0) categoryIndex.delete(skill.category);
  }

  for (const tag of skill.tags) {
    const tagSet = tagIndex.get(tag);
    if (tagSet) {
      tagSet.delete(id);
      if (tagSet.size === 0) tagIndex.delete(tag);
    }
  }

  registry.delete(id);
  return true;
}

function getSkill(id) {
  return registry.get(id) || null;
}

function listSkills(opts = {}) {
  let skills = [...registry.values()];

  if (opts.category) {
    skills = skills.filter(s => s.category === opts.category);
  }

  if (opts.tag) {
    skills = skills.filter(s => s.tags.includes(opts.tag));
  }

  if (opts.clearance) {
    const clearanceOrder = ['public', 'authenticated', 'paid', 'enterprise'];
    const maxIdx = clearanceOrder.indexOf(opts.clearance);
    if (maxIdx >= 0) {
      skills = skills.filter(s => clearanceOrder.indexOf(s.clearance) <= maxIdx);
    }
  }

  if (opts.outputKind) {
    skills = skills.filter(s => s.outputKind === opts.outputKind);
  }

  if (opts.query) {
    const q = opts.query.toLowerCase();
    skills = skills.filter(s =>
      s.label.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.tags.some(t => t.toLowerCase().includes(q))
    );
  }

  skills.sort((a, b) => a.order - b.order);

  // Honour an explicit limit of 0 ("return none"): `if (opts.limit)` treated 0
  // as "no limit" and returned every skill.
  if (typeof opts.limit === 'number' && opts.limit >= 0) {
    skills = skills.slice(0, opts.limit);
  }

  return skills;
}

function recommendSkills(intent, signals = {}) {
  // Callers pass either a string or an object like { query, tags } (cowork-engine
  // passes the latter). Normalize to a string so computeRelevanceScore can't
  // throw on `.toLowerCase()` — that throw was swallowed upstream, leaving the
  // ENTIRE cowork skills path silently dead on every turn.
  const intentStr = typeof intent === 'string'
    ? intent
    : (intent && (intent.query || intent.text || intent.intent)) || '';
  const candidates = [];

  for (const skill of registry.values()) {
    const score = computeRelevanceScore(skill, intentStr, signals);
    if (score > 0) {
      candidates.push({ skill, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  return candidates.slice(0, signals.limit || 5).map(c => c.skill);
}

function computeRelevanceScore(skill, intent, signals) {
  let score = 0;

  const intentLower = (typeof intent === 'string' ? intent : '').toLowerCase();
  const terms = tokenizeIntent(intentLower);
  const categoryLower = skill.category.toLowerCase();
  const descLower = skill.description.toLowerCase();
  const labelLower = skill.label.toLowerCase();

  // Only credit whole-intent matches when the intent is non-empty —
  // String.includes('') is ALWAYS true, so a blank intent used to give every
  // skill +0.5 and return the first 5 as bogus "recommendations".
  if (intentLower) {
    if (categoryLower === intentLower) score += 0.4;
    if (labelLower.includes(intentLower)) score += 0.3;
    if (descLower.includes(intentLower)) score += 0.2;
  }
  for (const term of terms) {
    if (labelLower.includes(term)) score += 0.15;
    if (descLower.includes(term)) score += 0.1;
    if (skill.tags.some(t => t.toLowerCase().includes(term))) score += 0.12;
  }

  if (signals.hasDocuments && skill.category === 'document') score += 0.3;
  if (signals.hasCode && skill.category === 'code') score += 0.3;
  if (signals.needsResearch && skill.category === 'research') score += 0.3;
  if (signals.needsAnalysis && skill.category === 'analysis') score += 0.3;

  if (signals.tags) {
    for (const tag of signals.tags) {
      if (skill.tags.includes(tag)) score += 0.1;
    }
  }

  if (skill.clearance === 'enterprise' && signals.userClearance !== 'enterprise') score *= 0.1;
  if (skill.clearance === 'paid' && !['paid', 'enterprise'].includes(signals.userClearance)) score *= 0.3;

  return score;
}

function tokenizeIntent(input) {
  const stop = new Set(['the', 'and', 'for', 'with', 'from', 'para', 'con', 'los', 'las', 'que']);
  return String(input || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9_-]+/)
    .filter(term => term.length >= 3 && !stop.has(term));
}

function verifyPrerequisites(skillId, context = {}) {
  const skill = registry.get(skillId);
  if (!skill) return { ok: false, missing: ['skill_not_found'] };

  const have = new Set();
  if (context.hasDocuments) have.add('attached_document');
  if (context.documentCount >= 2) have.add('attached_documents_2plus');
  if (context.extractedText) have.add('extracted_text');
  if (context.query) have.add('query_text');
  if (context.language) have.add('language_known');
  if (context.topic) have.add('topic_or_brief');
  if (context.webAccess !== false) have.add('web_access_enabled');
  if (context.collectionIndexed) have.add('user_collection_indexed');
  if (context.dataset) have.add('dataset_attached');
  // Without this, 'acceptance_criteria_clear' could never be satisfied, leaving
  // the long_running_task skill permanently unverifiable.
  if (context.acceptanceCriteria || context.acceptance_criteria) have.add('acceptance_criteria_clear');

  const missing = skill.prerequisites.filter(p => !have.has(p));
  return { ok: missing.length === 0, missing };
}

function getCategories() {
  const cats = {};
  for (const [category, ids] of categoryIndex) {
    cats[category] = ids.size;
  }
  return cats;
}

function getTags() {
  const tags = {};
  for (const [tag, ids] of tagIndex) {
    tags[tag] = ids.size;
  }
  return tags;
}

function getStats() {
  return {
    totalSkills: registry.size,
    categories: Object.fromEntries(
      [...categoryIndex.entries()].map(([k, v]) => [k, v.size])
    ),
    tags: Object.fromEntries(
      [...tagIndex.entries()].map(([k, v]) => [k, v.size])
    ),
  };
}

function reset() {
  registry.clear();
  categoryIndex.clear();
  tagIndex.clear();
  nextOrder = 1;
}

function bootBuiltins() {
  const builtins = [
    {
      id: 'rag_grounded_qa',
      label: 'RAG-Grounded Answer',
      category: 'information',
      description: 'Answer questions using only retrieved passages with citations.',
      tools: ['rag_retrieve', 'llm_reranker', 'nli_faithfulness'],
      prerequisites: ['user_collection_indexed', 'query_text'],
      clearance: 'authenticated',
      outputKind: 'text',
      tags: ['rag', 'citations', 'grounded'],
    },
    {
      id: 'web_research_citations',
      label: 'Web Research with Citations',
      category: 'research',
      description: 'Gather web sources and produce cited answers.',
      tools: ['web_search', 'fetch_url', 'llm_reranker'],
      prerequisites: ['query_text', 'web_access_enabled'],
      sideEffects: ['outbound_http_requests'],
      clearance: 'authenticated',
      outputKind: 'text',
      tags: ['web', 'citations', 'research'],
    },
    {
      id: 'deep_document_analysis',
      label: 'Deep Document Analysis',
      category: 'document',
      description: 'Domain-aware professional analysis with risk assessment, entity extraction, quality scoring.',
      tools: ['deep_document_analyzer', 'document_intelligence', 'rag_retrieve'],
      prerequisites: ['attached_document', 'extracted_text'],
      clearance: 'authenticated',
      outputKind: 'pair',
      tags: ['document', 'analysis', 'professional', 'risk'],
    },
    {
      id: 'cross_document_synthesis',
      label: 'Cross-Document Synthesis',
      category: 'document',
      description: 'Compare and synthesize insights across multiple documents.',
      tools: ['document_intelligence', 'deep_document_analyzer', 'document_comparison'],
      prerequisites: ['attached_documents_2plus'],
      clearance: 'authenticated',
      outputKind: 'text',
      tags: ['document', 'comparison', 'synthesis'],
    },
    {
      id: 'auto_file_analysis',
      label: 'Auto-File Content Analysis',
      category: 'document',
      description: 'Automatically ingest pasted/dropped content as analyzable documents with deep analysis.',
      tools: ['auto_file_bridge', 'deep_document_analyzer'],
      prerequisites: ['query_text'],
      clearance: 'authenticated',
      outputKind: 'pair',
      tags: ['document', 'auto-file', 'paste', 'ingestion'],
    },
    {
      id: 'code_generation_tests',
      label: 'Code + Tests Generation',
      category: 'code',
      description: 'Generate implementation with unit tests and validation.',
      tools: ['code_sandbox', 'generate_code', 'generate_tests', 'static_check', 'test_runner'],
      prerequisites: ['language_known'],
      sideEffects: ['artifact_files'],
      idempotent: false,
      clearance: 'authenticated',
      outputKind: 'artifact',
      tags: ['code', 'tests', 'generation'],
    },
    {
      id: 'repo_delivery_ci',
      label: 'Repository Delivery + CI Watch',
      category: 'code',
      description: 'Adapt an existing repository from external references without copying, preserve protected UI surfaces when requested, run validation, prepare a minimal diff, push to the target branch, and watch the newest GitHub Actions run until green.',
      tools: ['git_clone', 'repo_inspect', 'static_check', 'secret_scan', 'dependency_audit', 'test_runner', 'github_actions_monitor'],
      prerequisites: ['query_text'],
      sideEffects: ['local_workspace_changes', 'remote_git_push', 'outbound_http_requests'],
      idempotent: false,
      clearance: 'enterprise',
      outputKind: 'pair',
      tags: ['repo', 'github', 'ci', 'main', 'actions', 'no-ui', 'rewrite-not-copy'],
      examples: [
        {
          when: 'user provides a GitHub repo and asks to push to main only after green checks',
          call: 'inspect repo, implement independently, run tests, push, monitor newest main workflow',
        },
      ],
    },
    {
      id: 'hermes_playbook_import',
      label: 'Hermes Agent Import + Adaptation',
      category: 'agentic',
      description: 'Copy MIT-licensed Hermes Agent playbooks into an inactive upstream snapshot, map each folder/capability to SiraGPT, and recommend rewritten active SiraGPT skills and toolsets.',
      tools: ['license_audit', 'skill_snapshot', 'skill_manifest_map', 'folder_capability_map', 'playbook_recommend', 'static_check'],
      prerequisites: ['query_text'],
      sideEffects: ['local_workspace_changes'],
      idempotent: false,
      clearance: 'enterprise',
      outputKind: 'pair',
      tags: ['hermes', 'nous', 'agents', 'skills', 'toolsets', 'mit-license', 'playbook-import'],
      examples: [
        {
          when: 'user asks to copy Hermes Agent code and integrate it professionally into SiraGPT',
          call: 'copy upstream snapshot, preserve MIT attribution, generate folder map, activate rewritten SiraGPT playbooks and toolset tiers',
        },
      ],
    },
    {
      id: 'openclaw_playbook_import',
      label: 'OpenClaw Native Rewrite + Adaptation',
      category: 'agentic',
      description: 'Audit OpenClaw as reference material, map each folder/capability to SiraGPT, and rewrite behavior into active SiraGPT skills/services without copying upstream runtime code.',
      tools: ['license_audit', 'upstream_reference_audit', 'skill_manifest_map', 'folder_capability_map', 'playbook_recommend', 'static_check'],
      prerequisites: ['query_text'],
      sideEffects: ['local_workspace_changes'],
      idempotent: false,
      clearance: 'enterprise',
      outputKind: 'pair',
      tags: ['openclaw', 'agents', 'skills', 'folder-map', 'mit-license', 'playbook-import', 'rewrite-not-copy'],
      examples: [
        {
          when: 'user asks to integrate OpenClaw without copying its code',
          call: 'audit OpenClaw as reference-only input, generate folder map, activate rewritten SiraGPT playbooks and backend contracts',
        },
      ],
    },
    {
      id: 'open_source_agent_radar',
      label: 'Open Source Agent Radar',
      category: 'agentic',
      description: 'Compare trusted open-source agent, chat, workflow, and document projects, then translate their strongest ideas into SiraGPT-native contracts, validation gates, and guarded implementation plans.',
      tools: ['source_research', 'license_audit', 'agent_capability_map', 'folder_capability_map', 'playbook_recommend', 'static_check'],
      prerequisites: ['query_text'],
      sideEffects: ['local_workspace_changes'],
      idempotent: false,
      clearance: 'enterprise',
      outputKind: 'pair',
      tags: ['opensource', 'open-source', 'agents', 'software-factory', 'benchmarks', 'architecture', 'rewrite-not-copy', 'no-vendoring'],
      examples: [
        {
          when: 'user asks to find open-source projects to make SiraGPT more advanced',
          call: 'build the OSS radar, recommend SiraGPT-native adaptations, enforce no-copy and validation gates',
        },
      ],
    },
    {
      id: 'data_analysis_viz',
      label: 'Data Analysis with Visualization',
      category: 'data',
      description: 'Infer schema, compute stats, generate charts and dashboards.',
      tools: ['code_sandbox', 'create_chart', 'create_dashboard_html'],
      prerequisites: ['dataset_attached'],
      clearance: 'authenticated',
      outputKind: 'pair',
      tags: ['data', 'visualization', 'charts', 'dashboard'],
    },
    {
      id: 'presentation_generation',
      label: 'Presentation Generation',
      category: 'generation',
      description: 'Generate structured slide decks from briefs.',
      tools: ['document_renderer', 'create_chart', 'create_mermaid_diagram'],
      prerequisites: ['topic_or_brief'],
      sideEffects: ['artifact_file'],
      idempotent: false,
      clearance: 'paid',
      outputKind: 'artifact',
      tags: ['presentation', 'pptx', 'generation'],
    },
    {
      id: 'long_running_task',
      label: 'Long Autonomous Task',
      category: 'agentic',
      description: 'Multi-step task with checkpoints and durable events.',
      tools: ['agent_task_runner', 'progress_stream', 'durable_execution_store'],
      prerequisites: ['acceptance_criteria_clear'],
      sideEffects: ['durable_state', 'sse_events'],
      idempotent: false,
      clearance: 'enterprise',
      outputKind: 'pair',
      tags: ['agentic', 'long-running', 'autonomous'],
    },
    {
      id: 'conversational_answer',
      label: 'Conversational Answer',
      category: 'conversational',
      description: 'Direct answer using memory + short context.',
      tools: [],
      prerequisites: ['query_text'],
      clearance: 'public',
      outputKind: 'text',
      tags: ['conversational', 'direct'],
    },
    {
      id: 'memory_enhanced_qa',
      label: 'Memory-Enhanced Q&A',
      category: 'conversational',
      description: 'Answer using active memory with long-term recall and context promotion.',
      tools: ['active_memory', 'rag_retrieve'],
      prerequisites: ['query_text'],
      clearance: 'authenticated',
      outputKind: 'text',
      tags: ['memory', 'conversational', 'recall'],
    },
    {
      id: 'session_orchestration',
      label: 'Multi-Session Orchestration',
      category: 'agentic',
      description: 'Search, resume, spawn and coordinate agent sessions for complex tasks.',
      tools: ['session_manager', 'session_search', 'agent_task_runner'],
      prerequisites: ['query_text'],
      clearance: 'authenticated',
      outputKind: 'pair',
      tags: ['session', 'search', 'history', 'orchestration', 'multi-agent'],
    },
    {
      id: 'image_generation',
      label: 'Image Generation',
      category: 'generation',
      description: 'Generate images from textual prompts.',
      tools: ['generate_image'],
      prerequisites: ['query_text'],
      sideEffects: ['artifact_file'],
      idempotent: false,
      clearance: 'paid',
      outputKind: 'artifact',
      tags: ['image', 'generation', 'visual'],
    },
    {
      id: 'document_generation',
      label: 'Professional Document Generation',
      category: 'generation',
      description: 'Generate formatted documents (DOCX, XLSX, PPTX, PDF) with professional quality.',
      tools: ['create_document', 'verify_artifact'],
      prerequisites: ['topic_or_brief'],
      sideEffects: ['artifact_file'],
      idempotent: false,
      clearance: 'authenticated',
      outputKind: 'artifact',
      tags: ['document', 'generation', 'professional'],
    },
  ];

  for (const desc of builtins) {
    registerSkill(desc);
  }

  return builtins.length;
}

const booted = bootBuiltins();

module.exports = {
  registerSkill,
  unregisterSkill,
  getSkill,
  listSkills,
  recommendSkills,
  verifyPrerequisites,
  getCategories,
  getTags,
  getStats,
  reset,
  bootBuiltins,
  SKILL_DIR,
};
