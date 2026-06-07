'use strict';

/**
 * Toolset registry — Hermes-inspired tiered tool bundles for SiraGPT agents.
 *
 * Hermes groups tools into composable toolsets (core, research, webhook-safe, …).
 * SiraGPT maps those ideas onto existing tool-manifest names instead of copying
 * Python toolsets.py verbatim.
 */

const CORE_TOOLS = Object.freeze([
  'web_search',
  'fetch_url',
  'web_extract',
  'session_search',
  'session_list',
  'session_history',
  'read_file',
  'write_file',
  'bash_exec',
  'python_exec',
  'memory_recall',
  'agent_task',
  'create_chart',
  'create_mermaid_diagram',
  'generate_image',
  'create_document',
]);

const RESEARCH_TOOLS = Object.freeze([
  ...CORE_TOOLS,
  'deep_analyze',
  'docintel_analyze',
  'compare_documents',
  'rag_retrieve',
]);

const WEBHOOK_SAFE_TOOLS = Object.freeze([
  'web_search',
  'fetch_url',
  'web_extract',
  'session_search',
  'session_list',
  'session_history',
  'memory_recall',
  'create_chart',
  'create_mermaid_diagram',
]);

const VISUAL_TOOLS = Object.freeze([
  'generate_image',
  'create_chart',
  'create_dashboard_html',
  'create_mermaid_diagram',
  'create_infographic_svg',
  'create_process_flow',
  'create_timeline',
  'create_swot_analysis',
  'create_business_model_canvas',
]);

const ENTERPRISE_TOOLS = Object.freeze([
  ...RESEARCH_TOOLS,
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'github_actions_monitor',
  'secret_scan',
  'dependency_audit',
  'license_audit',
  'skill_manifest_map',
  'folder_capability_map',
  'playbook_recommend',
]);

const TOOLSETS = Object.freeze({
  core: {
    id: 'core',
    label: 'Core Agent',
    description: 'Default chat + files + memory + basic visual tools.',
    tools: CORE_TOOLS,
    clearance: 'authenticated',
  },
  research: {
    id: 'research',
    label: 'Research',
    description: 'Scientific/document research with RAG and deep analysis.',
    tools: RESEARCH_TOOLS,
    clearance: 'authenticated',
  },
  webhook_safe: {
    id: 'webhook_safe',
    label: 'Webhook Safe',
    description: 'Minimal tool surface for untrusted inbound webhook content.',
    tools: WEBHOOK_SAFE_TOOLS,
    clearance: 'authenticated',
  },
  visual: {
    id: 'visual',
    label: 'Visual Generation',
    description: 'Charts, diagrams, dashboards, and infographic tools.',
    tools: VISUAL_TOOLS,
    clearance: 'paid',
  },
  enterprise: {
    id: 'enterprise',
    label: 'Enterprise Delivery',
    description: 'Repo delivery, audits, playbook mapping, and CI watch.',
    tools: ENTERPRISE_TOOLS,
    clearance: 'enterprise',
  },
  hermes_core: {
    id: 'hermes_core',
    label: 'Hermes Core Parity',
    description: 'Closest SiraGPT bundle to Hermes _HERMES_CORE_TOOLS.',
    tools: Object.freeze([
      'web_search',
      'fetch_url',
      'web_extract',
      'session_search',
      'bash_exec',
      'python_exec',
      'read_file',
      'write_file',
      'generate_image',
      'memory_recall',
      'agent_task',
      'create_mermaid_diagram',
    ]),
    clearance: 'authenticated',
  },
});

const COMPOSED = Object.freeze({
  full_stack: ['core', 'research', 'visual'],
  delivery: ['core', 'enterprise'],
});

function listToolsets() {
  return Object.values(TOOLSETS).map((toolset) => ({
    id: toolset.id,
    label: toolset.label,
    description: toolset.description,
    toolCount: toolset.tools.length,
    clearance: toolset.clearance,
  }));
}

function getToolset(id) {
  return TOOLSETS[id] ? { ...TOOLSETS[id], tools: [...TOOLSETS[id].tools] } : null;
}

function resolveToolset(id, seen = new Set()) {
  if (seen.has(id)) return [];
  seen.add(id);

  const composed = COMPOSED[id];
  if (composed) {
    const merged = new Set();
    for (const child of composed) {
      for (const tool of resolveToolset(child, seen)) merged.add(tool);
    }
    return [...merged];
  }

  const toolset = TOOLSETS[id];
  return toolset ? [...toolset.tools] : [];
}

function recommendToolset(query, opts = {}) {
  const terms = String(query || '').toLowerCase();
  const scored = [];

  for (const toolset of Object.values(TOOLSETS)) {
    let score = 0;
    if (terms.includes('research') || terms.includes('paper') || terms.includes('arxiv')) {
      if (toolset.id === 'research') score += 3;
    }
    if (terms.includes('webhook') || terms.includes('untrusted') || terms.includes('injection')) {
      if (toolset.id === 'webhook_safe') score += 4;
    }
    if (terms.includes('chart') || terms.includes('diagram') || terms.includes('visual')) {
      if (toolset.id === 'visual') score += 3;
    }
    if (terms.includes('github') || terms.includes('ci') || terms.includes('repo') || terms.includes('enterprise')) {
      if (toolset.id === 'enterprise') score += 3;
    }
    if (terms.includes('hermes') || terms.includes('nous')) {
      if (toolset.id === 'hermes_core') score += 2;
    }
    if (score > 0) {
      scored.push({ id: toolset.id, label: toolset.label, score, tools: toolset.tools.length });
    }
  }

  if (scored.length === 0) {
    return [{ id: 'core', label: TOOLSETS.core.label, score: 1, tools: TOOLSETS.core.tools.length }];
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, opts.limit || 3);
}

function toolsetForClearance(clearance) {
  const order = ['authenticated', 'paid', 'enterprise'];
  const idx = order.indexOf(clearance);
  if (idx >= 2) return 'enterprise';
  if (idx === 1) return 'visual';
  return 'core';
}

module.exports = {
  CORE_TOOLS,
  RESEARCH_TOOLS,
  WEBHOOK_SAFE_TOOLS,
  VISUAL_TOOLS,
  ENTERPRISE_TOOLS,
  TOOLSETS,
  COMPOSED,
  listToolsets,
  getToolset,
  resolveToolset,
  recommendToolset,
  toolsetForClearance,
};
