'use strict';

const fs = require('fs');
const path = require('path');

const VALID_STATUSES = new Set([
  'covered',
  'adapted',
  'partial',
  'reference-only',
  'not-applicable',
]);

function native(status, adaptedSkills, siraServices, reason) {
  return { status, adaptedSkills, siraServices, reason };
}

function connector(reason, siraServices = []) {
  return native('reference-only', [], siraServices, reason);
}

function localOnly(reason) {
  return native('not-applicable', [], [], reason);
}

/**
 * Capability-level rewrites for OpenClaw's public skill catalog.
 *
 * Entries point only at SiraGPT-owned runtime surfaces. They do not load or
 * execute upstream code. A nominal covered/adapted status is downgraded to
 * partial when its declared SiraGPT evidence is missing from the audited tree.
 */
const PUBLIC_SKILL_ADAPTATIONS = Object.freeze({
  '1password': connector('Requires an explicit secrets-manager connector and user authorization.', ['backend/src/services/credentials']),
  'apple-notes': localOnly('Apple Notes is a device-local macOS application, not a SiraGPT server capability.'),
  'apple-reminders': localOnly('Apple Reminders is a device-local macOS application, not a SiraGPT server capability.'),
  'bear-notes': localOnly('Bear is a device-local application and needs a separately authorized connector.'),
  blogwatcher: native('adapted', ['cron_schedule', 'web_search', 'read_url'], ['backend/src/services/scheduler', 'backend/src/skills/web_search', 'backend/src/skills/read_url'], 'SiraGPT can schedule recurring web retrieval and summarization without the upstream CLI.'),
  blucli: localOnly('BluOS device control is outside the cloud assistant runtime.'),
  camsnap: localOnly('Private camera access requires a dedicated, user-authorized device connector.'),
  clawhub: native('adapted', ['openclaw_playbook_import'], ['backend/src/services/agents/plugin-registry.js', 'backend/src/services/agents/agent-plugin-lifecycle.js'], 'SiraGPT has a policy-gated native plugin and skill lifecycle.'),
  'coding-agent': native('adapted', ['repo_delivery_ci', 'long_running_task', 'session_spawn'], ['backend/src/services/codex', 'backend/src/services/agents/agent-task-runner.js', 'backend/src/skills/session_spawn'], 'SiraGPT delegates isolated code work through its own task, workspace, and verification runtime.'),
  'diagram-maker': native('adapted', ['data_analysis_viz', 'presentation_generation'], ['backend/src/services/agents/visual-media-tools.js', 'backend/src/services/design'], 'SiraGPT generates diagrams and visual artifacts through native media and document tools.'),
  eightctl: localOnly('Eight Sleep hardware control is outside the SiraGPT server runtime.'),
  gemini: native('adapted', [], ['backend/src/services/agents/providers/gemini-adapter.js', 'backend/src/services/agents/provider-registry.js'], 'Gemini is routed through SiraGPT provider adapters instead of a local CLI.'),
  'gh-issues': native('adapted', ['repo_delivery_ci', 'session_spawn'], ['backend/src/services/github', 'backend/src/services/agents/github-actions-tool.js'], 'Issue-to-fix work uses SiraGPT GitHub services, isolated sessions, and CI proof.'),
  gifgrep: native('partial', ['image_generation', 'web_search'], ['backend/src/services/agents/visual-media-tools.js'], 'Image generation exists; a dedicated licensed GIF catalog connector is still required.'),
  github: native('adapted', ['repo_delivery_ci'], ['backend/src/services/github', 'backend/src/services/agents/github-actions-tool.js'], 'GitHub repository and Actions operations use SiraGPT-owned services.'),
  gog: connector('Google Workspace operations require explicit OAuth scopes per user.', ['backend/src/services/google-mcp.js']),
  goplaces: native('partial', [], ['backend/src/services/google-mcp.js'], 'Google integration exists, but Places needs a dedicated scoped tool contract.'),
  healthcheck: native('adapted', [], ['backend/src/services/observability/health-check.js', 'backend/src/services/agents/agent-runtime-hardening-matrix.js'], 'Runtime, dependency, and deployment health are audited by SiraGPT services.'),
  himalaya: connector('Mailbox access requires an email connector with per-user IMAP or OAuth authorization.'),
  mcporter: native('adapted', [], ['backend/src/services/connectors/mcp-tool-registry.js', 'backend/src/services/ai-product-os/mcp-gateway.js'], 'MCP tools are discovered and policy-gated through SiraGPT registries.'),
  'meme-maker': native('partial', ['image_generation'], ['backend/src/services/agents/visual-media-tools.js'], 'Image generation is active; template search and rights-aware meme catalogs remain separate work.'),
  'model-usage': native('adapted', [], ['backend/src/services/observability', 'backend/src/services/agents/metrics.js'], 'SiraGPT records model and agent usage through its observability layer.'),
  'nano-pdf': native('adapted', ['document_generation'], ['backend/src/services/source-preserving-document-edit.js', 'backend/src/services/document-editing'], 'PDF edits use SiraGPT source-preserving document services.'),
  'node-connect': native('partial', [], ['android', 'ios', 'backend/src/services/webauthn'], 'Mobile clients exist; a unified node-pairing contract is not yet active.'),
  'node-inspect-debugger': native('adapted', ['code_generation_tests'], ['backend/src/services/agents/debug-agent.js', 'backend/src/services/agents/performance-tracer.js'], 'Node debugging is handled inside bounded code and profiling workflows.'),
  notion: connector('Notion requires a scoped per-user connector before activation.', ['backend/src/services/agents/platform-extension-catalog.js']),
  obsidian: localOnly('Obsidian vault access is local filesystem access and is not enabled on the server.'),
  'openai-whisper': native('adapted', [], ['backend/src/services/media', 'backend/src/services/agents/audio-media-tools.js'], 'Speech-to-text is exposed through SiraGPT media services.'),
  'openai-whisper-api': native('adapted', [], ['backend/src/services/media', 'backend/src/services/agents/audio-media-tools.js'], 'Cloud transcription is routed through SiraGPT provider and media policies.'),
  openhue: localOnly('Philips Hue control requires a private LAN device bridge.'),
  oracle: native('adapted', [], ['backend/src/services/agents/multi-judge.js', 'backend/src/services/agents/provider-registry.js'], 'Second-model review uses SiraGPT multi-judge and provider routing.'),
  ordercli: localOnly('Food delivery account control is outside the SiraGPT core runtime.'),
  peekaboo: native('partial', [], ['backend/src/services/computer-use.js', 'backend/src/services/agents/host-bash-tool.js'], 'Computer-use foundations exist; local macOS capture requires an explicit device session.'),
  'python-debugpy': native('adapted', ['code_generation_tests'], ['backend/src/services/agents/code-sandbox.js', 'backend/src/services/agents/debug-agent.js'], 'Python debugging runs in SiraGPT bounded code workspaces.'),
  sag: native('adapted', [], ['backend/src/services/agents/audio-media-tools.js', 'backend/src/services/media'], 'Text-to-speech is handled by SiraGPT audio providers.'),
  'session-logs': native('covered', ['session_list', 'session_history', 'session_search'], ['backend/src/skills/session_list', 'backend/src/skills/session_history', 'backend/src/skills/session_search'], 'SiraGPT exposes owner-scoped session discovery, history, and search skills.'),
  'sherpa-onnx-tts': native('partial', [], ['backend/src/services/agents/audio-media-tools.js'], 'Local TTS is catalogued but requires a provisioned runtime on the target host.'),
  'skill-creator': native('adapted', ['openclaw_playbook_import'], ['backend/src/services/agents/plugin-registry.js', 'backend/src/services/agents/skill-runner.js'], 'SiraGPT skills use validated manifests, capability policy, and a bounded runner.'),
  songsee: native('partial', [], ['backend/src/services/agents/audio-media-tools.js', 'backend/src/services/agents/visual-media-tools.js'], 'Audio and visual primitives exist; spectrogram generation needs a dedicated deterministic adapter.'),
  sonoscli: localOnly('Sonos control requires a private LAN device bridge.'),
  spike: native('adapted', ['code_generation_tests'], ['backend/src/services/agents/code-sandbox.js', 'backend/src/services/agents/speculative-executor.js'], 'Feasibility spikes run as bounded code experiments with tests.'),
  'spotify-player': localOnly('Spotify playback controls a user device and requires a separately authorized connector.'),
  summarize: native('covered', ['summarize'], ['backend/src/skills/summarize'], 'SiraGPT has a native URL, collection-file, and text summarization skill.'),
  taskflow: native('covered', ['task_flow_create', 'task_flow_list', 'task_flow_get', 'task_flow_update'], ['backend/src/services/agents/task-flow-store.js', 'backend/src/skills/task_flow_create', 'backend/src/skills/task_flow_list', 'backend/src/skills/task_flow_get', 'backend/src/skills/task_flow_update'], 'SiraGPT exposes owner-scoped durable flows with revision-checked wait, block, resume, child-task linkage, completion, failure, and cancellation transitions.'),
  'taskflow-inbox-triage': native('partial', ['long_running_task', 'session_orchestration'], ['backend/src/services/agents/durable-execution-store.js', 'backend/src/orchestration/multichannel'], 'Durable flow primitives exist; inbox-specific connectors require user authorization.'),
  'things-mac': localOnly('Things is a device-local macOS application.'),
  tmux: native('partial', ['repo_delivery_ci'], ['backend/src/services/agents/host-bash-tool.js'], 'Interactive shell control is restricted to approved workspaces and is not a general chat skill.'),
  trello: connector('Trello requires a scoped per-user API connector.'),
  'video-frames': native('adapted', [], ['backend/src/services/agents/visual-media-tools.js', 'backend/src/services/media'], 'Video inspection and frame-based media analysis use SiraGPT media services.'),
  weather: native('covered', ['weather'], ['backend/src/skills/weather'], 'SiraGPT has a native structured current-weather and forecast skill.'),
  xurl: connector('Authenticated X operations require a scoped social connector and explicit write approval.', ['backend/src/services/agents/web-search/providers/x.js']),
});

function pathExists(repoRoot, relativePath) {
  return fs.existsSync(path.join(repoRoot, relativePath));
}

function classifyPublicSkill(skill, opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  const definition = PUBLIC_SKILL_ADAPTATIONS[skill.id] || connector(
    'No SiraGPT-native contract has been approved for this upstream capability.',
  );
  if (!VALID_STATUSES.has(definition.status)) {
    throw new Error(`invalid OpenClaw public skill status for ${skill.id}: ${definition.status}`);
  }

  const evidence = (definition.siraServices || []).filter((candidate) => pathExists(repoRoot, candidate));
  const missingEvidence = (definition.siraServices || []).filter((candidate) => !pathExists(repoRoot, candidate));
  const status = ['covered', 'adapted'].includes(definition.status) && missingEvidence.length > 0
    ? 'partial'
    : definition.status;

  return {
    upstream: skill.id,
    description: skill.description,
    status,
    adaptedSkills: definition.adaptedSkills || [],
    availableSkills: status === 'covered' || status === 'adapted'
      ? (definition.adaptedSkills || [])
      : [],
    sira_surface: (definition.siraServices || []).join(', ') || null,
    evidence,
    missing_evidence: missingEvidence,
    activation: status === 'covered'
      ? 'runtime-active'
      : status === 'adapted'
        ? 'native-service-active'
        : status === 'partial'
          ? 'native-contract-incomplete'
          : 'inactive-reference',
    reason: definition.reason,
    source_policy: 'native-rewrite-no-active-upstream-code',
  };
}

function buildPublicSkillCatalog(skills, opts = {}) {
  return (skills || []).slice(0, 100).map((skill) => classifyPublicSkill(skill, opts));
}

function countPublicSkillCoverage(catalog) {
  return (catalog || []).reduce((counts, item) => {
    counts[item.status] = (counts[item.status] || 0) + 1;
    return counts;
  }, {});
}

module.exports = {
  VALID_STATUSES,
  PUBLIC_SKILL_ADAPTATIONS,
  classifyPublicSkill,
  buildPublicSkillCatalog,
  countPublicSkillCoverage,
};
