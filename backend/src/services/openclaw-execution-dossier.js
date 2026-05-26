'use strict';

const DEFAULT_CHANNELS = Object.freeze([
  'current_user_message',
  'recent_thread_history',
  'persistent_memory',
  'attachments',
  'tool_observations',
  'external_sources',
]);

const TOOL_FAMILIES = Object.freeze({
  memory: ['memory_recall'],
  retrieval: ['rag_retrieve', 'self_rag_answer', 'read_url', 'web_search'],
  documents: ['docintel_analyze', 'docintel_retrieve', 'docintel_extract_tables', 'docintel_compare', 'compare_documents'],
  coding: ['clone_project', 'host_bash', 'host_file', 'bash_exec', 'python_exec', 'run_tests', 'npm_install'],
  delivery: ['create_document', 'verify_artifact', 'auto_file'],
  github: ['git_commit_push', 'git_workflow', 'commit_changes', 'push_changes', 'check_ci_status', 'monitor_ci', 'create_pr'],
});

const MODE_PATTERNS = Object.freeze([
  {
    mode: 'software_agent',
    rx: /\b(c[oó]digo|repo|github|git|commit|push|deploy|desplieg|pr|pull request|backend|frontend|app|bug|error|arregla|implementa|refactor|tests?)\b/i,
  },
  {
    mode: 'document_intelligence',
    rx: /\b(pdf|word|excel|ppt|documento|archivo|tabla|tesis|informe|adjunto|subido|uploaded|spreadsheet)\b/i,
  },
  {
    mode: 'research_agent',
    rx: /\b(investiga|busca|web|fuente|link|url|paper|art[ií]culo|reciente|latest|verify|verifica)\b/i,
  },
  {
    mode: 'repair_agent',
    rx: /\b(no entiende|no entend|mal|equivoc|corrige|regenera|retry|wrong|misunderstood|not what i meant)\b/i,
  },
  {
    mode: 'planning_agent',
    rx: /\b(plan|roadmap|estrategia|arquitectura|diseña|estructura|pasos|coordina)\b/i,
  },
]);

function uniq(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function normalizeToolNames(toolNames) {
  if (!Array.isArray(toolNames)) return [];
  return uniq(toolNames.map((tool) => (typeof tool === 'string' ? tool : tool?.name)).filter(Boolean).map(String));
}

function scoreMode(prompt, profile = {}) {
  const text = String(prompt || '');
  const scores = new Map();
  for (const pattern of MODE_PATTERNS) {
    if (pattern.rx.test(text)) scores.set(pattern.mode, (scores.get(pattern.mode) || 0) + 0.55);
  }
  if (profile.signals?.wantsRepair) scores.set('repair_agent', (scores.get('repair_agent') || 0) + 0.45);
  if (profile.signals?.referencesVisualContext) scores.set('document_intelligence', (scores.get('document_intelligence') || 0) + 0.35);
  if (profile.signals?.likelyLongRunning) scores.set('software_agent', (scores.get('software_agent') || 0) + 0.2);
  if (!scores.size) scores.set('conversation_agent', 0.5);
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  return {
    primary: ranked[0][0],
    confidence: Number(Math.min(0.98, ranked[0][1]).toFixed(2)),
    alternates: ranked.slice(1, 4).map(([mode, confidence]) => ({
      mode,
      confidence: Number(Math.min(0.98, confidence).toFixed(2)),
    })),
  };
}

function pickToolPlan(mode, toolNames) {
  const available = normalizeToolNames(toolNames);
  const byFamily = {};
  for (const [family, names] of Object.entries(TOOL_FAMILIES)) {
    byFamily[family] = names.filter((name) => available.includes(name));
  }

  const orderedFamilies = {
    software_agent: ['memory', 'coding', 'github', 'retrieval', 'delivery'],
    document_intelligence: ['memory', 'documents', 'retrieval', 'delivery'],
    research_agent: ['memory', 'retrieval', 'documents', 'delivery'],
    repair_agent: ['memory', 'documents', 'coding', 'retrieval', 'delivery', 'github'],
    planning_agent: ['memory', 'retrieval', 'documents', 'coding', 'delivery'],
    conversation_agent: ['memory', 'retrieval'],
  }[mode] || ['memory', 'retrieval'];

  const selected = [];
  for (const family of orderedFamilies) selected.push(...(byFamily[family] || []));

  return {
    available,
    selected: uniq(selected).slice(0, 18),
    missingFamilies: orderedFamilies.filter((family) => !(byFamily[family] || []).length),
    byFamily,
  };
}

function buildEvidenceChannels({ profile = {}, context = {} } = {}) {
  const channels = DEFAULT_CHANNELS.map((name) => ({
    name,
    present: false,
    trust: name === 'tool_observations' ? 'high' : 'medium',
    rule: 'keep_separate_until_grounded',
  }));

  const set = (name, patch) => {
    const channel = channels.find((c) => c.name === name);
    if (channel) Object.assign(channel, patch);
  };

  set('current_user_message', { present: true, trust: 'medium' });
  set('recent_thread_history', {
    present: Number(profile.signals?.recentTurnCount || 0) > 0 || Array.isArray(context.history) && context.history.length > 0,
    trust: 'medium',
  });
  set('persistent_memory', {
    present: Number(profile.signals?.memoryFactCount || 0) > 0 || Array.isArray(context.memoryFacts) && context.memoryFacts.length > 0,
    trust: 'medium',
  });
  set('attachments', {
    present: Number(profile.signals?.attachmentCount || 0) > 0 || Array.isArray(context.documents) && context.documents.length > 0,
    trust: 'medium',
  });
  set('tool_observations', {
    present: Array.isArray(context.toolResults) && context.toolResults.length > 0,
    trust: 'high',
  });
  set('external_sources', {
    present: Array.isArray(context.webResults) && context.webResults.length > 0,
    trust: 'source_dependent',
  });

  return channels;
}

function buildWorkPackets(mode, prompt, profile = {}) {
  const packets = [
    {
      id: 'understand',
      label: 'Understand intent and constraints',
      required: true,
      doneWhen: 'primary goal, deliverable, and blocking ambiguity are explicit',
    },
    {
      id: 'ground',
      label: 'Ground in evidence channels',
      required: true,
      doneWhen: 'claims map to user text, history, files, memory, tool output, or cited sources',
    },
    {
      id: 'execute',
      label: mode === 'software_agent' ? 'Inspect, edit, and run checks' : 'Produce the requested answer or artifact',
      required: true,
      doneWhen: mode === 'software_agent' ? 'changed files are verified by available tests or a precise failure is reported' : 'deliverable satisfies the inferred task contract',
    },
    {
      id: 'verify',
      label: 'Verify result before final response',
      required: true,
      doneWhen: 'quality gates pass or residual risk is explicitly stated',
    },
  ];

  if (profile.signals?.wantsRepair || mode === 'repair_agent') {
    packets.splice(1, 0, {
      id: 'repair',
      label: 'Repair prior misunderstanding',
      required: true,
      doneWhen: 'mismatch with the previous answer is addressed and a corrected result is generated',
    });
  }

  if (profile.signals?.highRisk) {
    packets.push({
      id: 'approval',
      label: 'Require confirmation for external or irreversible action',
      required: true,
      doneWhen: 'explicit user approval is present before sending, deleting, paying, deploying, or publishing',
    });
  }

  if (/\b(millones|millions|much[ií]simas|1000|mil)\b/i.test(String(prompt || ''))) {
    packets.push({
      id: 'scale',
      label: 'Translate scale request into durable architecture',
      required: true,
      doneWhen: 'system capability increases through modules, tests, and contracts rather than artificial code volume',
    });
  }

  return packets;
}

function buildQualityGates(mode, profile = {}) {
  const gates = [
    'answer_uses_thread_context',
    'uncertain_claims_are_marked',
    'no_fake_tool_or_filesystem_claims',
  ];
  if (profile.signals?.referencesVisualContext) gates.push('attachment_or_visual_evidence_checked');
  if (profile.signals?.wantsRepair) gates.push('previous_mismatch_corrected');
  if (mode === 'software_agent') gates.push('repo_inspected', 'tests_or_typecheck_attempted', 'changed_files_summarized');
  if (mode === 'document_intelligence') gates.push('document_evidence_cited_or_limitation_stated');
  if (mode === 'research_agent') gates.push('fresh_sources_used_when_time_sensitive');
  if (profile.signals?.highRisk) gates.push('explicit_confirmation_before_external_action');
  return uniq(gates);
}

function buildRiskControls(profile = {}) {
  const controls = [
    {
      risk: 'context_conflation',
      mitigation: 'keep user, history, memory, attachments, tools, and web sources as separate evidence channels',
    },
    {
      risk: 'false_completion',
      mitigation: 'do not claim code, deploy, file creation, or external action happened unless a tool observed it',
    },
  ];
  if (profile.signals?.highRisk) {
    controls.push({
      risk: 'external_or_irreversible_action',
      mitigation: 'pause for explicit confirmation before executing',
    });
  }
  if (profile.signals?.referencesVisualContext) {
    controls.push({
      risk: 'visual_or_document_hallucination',
      mitigation: 'state only what is visible/extracted and request inspection tooling if unavailable',
    });
  }
  if (profile.signals?.wantsRepair) {
    controls.push({
      risk: 'repeat_misunderstanding',
      mitigation: 'compare against the prior request and regenerate from the corrected interpretation',
    });
  }
  return controls;
}

function buildExecutionDossier({ prompt = '', profile = {}, context = {}, toolNames = [] } = {}) {
  const mode = scoreMode(prompt, profile);
  const toolPlan = pickToolPlan(mode.primary, toolNames.length ? toolNames : profile.tools);
  const evidenceChannels = buildEvidenceChannels({ profile, context });

  return {
    version: 'openclaw-execution-dossier-2026-05',
    operatingMode: mode,
    evidenceChannels,
    workPackets: buildWorkPackets(mode.primary, prompt, profile),
    toolPlan,
    qualityGates: buildQualityGates(mode.primary, profile),
    riskControls: buildRiskControls(profile),
    responseContract: {
      language: 'es',
      finalAnswerMustInclude: [
        'what_was_done_or_what_can_be_done',
        'verification_status',
        'blocked_items_or_residual_risk_when_any',
      ],
      askClarifyingQuestionOnlyIf: 'missing_input_blocks_execution_or_high_risk_confirmation_is_required',
    },
  };
}

function buildDossierPromptBlock(dossier, opts = {}) {
  if (!dossier || typeof dossier !== 'object') return '';
  const maxTools = opts.maxTools || 12;
  const channels = (dossier.evidenceChannels || [])
    .filter((channel) => channel.present)
    .map((channel) => `${channel.name}:${channel.trust}`)
    .join(', ') || 'current_user_message:medium';
  const packets = (dossier.workPackets || [])
    .slice(0, opts.maxPackets || 8)
    .map((packet, index) => `${index + 1}. ${packet.label} — done when ${packet.doneWhen}`)
    .join('\n');
  const tools = (dossier.toolPlan?.selected || []).slice(0, maxTools).join(', ') || 'none selected';
  const gates = (dossier.qualityGates || []).slice(0, opts.maxGates || 10).join(', ');
  const risks = (dossier.riskControls || [])
    .slice(0, opts.maxRisks || 5)
    .map((control) => `- ${control.risk}: ${control.mitigation}`)
    .join('\n');

  return [
    '## OpenClaw Execution Dossier',
    `Operating mode: ${dossier.operatingMode?.primary || 'conversation_agent'} (${Math.round((dossier.operatingMode?.confidence || 0) * 100)}%).`,
    `Evidence channels present: ${channels}.`,
    '',
    '### Work Packets',
    packets,
    '',
    '### Tool Plan',
    `Preferred tools: ${tools}.`,
    dossier.toolPlan?.missingFamilies?.length ? `Missing tool families: ${dossier.toolPlan.missingFamilies.join(', ')}.` : '',
    '',
    '### Quality Gates',
    gates,
    '',
    '### Risk Controls',
    risks,
  ].filter(Boolean).join('\n');
}

module.exports = {
  DEFAULT_CHANNELS,
  TOOL_FAMILIES,
  buildDossierPromptBlock,
  buildExecutionDossier,
  buildEvidenceChannels,
  buildQualityGates,
  buildRiskControls,
  buildWorkPackets,
  normalizeToolNames,
  pickToolPlan,
  scoreMode,
};
