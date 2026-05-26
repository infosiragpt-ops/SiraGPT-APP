'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_SNAPSHOT_SHA = '2517917de34eeb6a40f5a17a2e59d9746803dfa5';

const FOLDER_CAPABILITY_MAP = Object.freeze([
  { hermes: 'agent', sira: 'backend/src/services/agents/hermes-agent-bridge.js', status: 'integrated', strategy: 'runTurn + compressConversation over agent-entry and context-compactor' },
  { hermes: 'skills', sira: '.agents/skills, backend/src/services/skills-registry.js', status: 'integrated', strategy: 'inactive upstream snapshot plus rewritten active SiraGPT skills' },
  { hermes: 'optional-skills', sira: 'backend/src/services/agents/hermes-optional-skills-bridge.js', status: 'integrated', strategy: 'search + activate optional upstream skills with SiraGPT playbook mapping' },
  { hermes: 'plugins', sira: 'backend/src/services/agents/hermes-plugin-bridge.js', status: 'integrated', strategy: 'Hermes plugin catalog registered in plugin-registry at boot' },
  { hermes: 'gateway', sira: 'backend/src/orchestration/multichannel, backend/src/services/agents/hermes-gateway-bridge.js', status: 'integrated', strategy: 'Hermes send_message + inbound routing via OpenClaw adapter bridge' },
  { hermes: 'tools', sira: 'backend/src/services/agents/hermes-tools.js', status: 'integrated', strategy: 'Hermes tool names mapped to native SiraGPT bridges' },
  { hermes: 'toolsets.py', sira: 'backend/src/services/agents/toolset-registry.js', status: 'integrated', strategy: 'tiered tool bundles: core, research, webhook-safe, visual, enterprise' },
  { hermes: 'trajectory_compressor.py', sira: 'backend/src/services/agents/trajectory-compactor.js', status: 'integrated', strategy: 'middle-turn compression for eval/training trajectories' },
  { hermes: 'agent/context_compressor.py', sira: 'backend/src/services/sira/context-compactor.js', status: 'integrated', strategy: 'Hermes compaction preamble and tail protection via hermes-context-patterns.js' },
  { hermes: 'hermes_state.py', sira: 'backend/src/services/agents/task-store.js, hermes-memory-bridge.js', status: 'integrated', strategy: 'durable task state + session search + active memory promotion' },
  { hermes: 'cron', sira: 'backend/src/services/agents/cron/hermes-cron-bridge.js', status: 'integrated', strategy: 'Hermes cron API over SiraGPT scheduler + agent-entry invoker' },
  { hermes: 'providers', sira: 'backend/src/services/agents/providers', status: 'integrated', strategy: 'provider adapters + hermes-cli model command' },
  { hermes: 'acp_adapter', sira: 'backend/src/services/agents/hermes-delegate-bridge.js', status: 'integrated', strategy: 'subagent orchestration and delegate_task tool' },
  { hermes: 'cli.py', sira: 'backend/src/services/agents/hermes-cli-bridge.js, /api/hermes/cli/:command', status: 'integrated', strategy: 'Hermes CLI commands as HTTP/JS without Python' },
  { hermes: 'run_agent.py', sira: 'backend/src/services/agents/agent-entry.js, hermes-runtime.js', status: 'integrated', strategy: 'unified programmatic agent entry + boot sequence' },
  { hermes: 'web', sira: 'backend/src/routes/hermes.js, backend/src/services/agents/hermes-tui-bridge.js', status: 'integrated', strategy: 'Hermes web/TUI slash protocol exposed as /api/hermes/tui/* without Next.js UI changes' },
  { hermes: 'ui-tui', sira: 'backend/src/services/agents/hermes-tui-bridge.js', status: 'integrated', strategy: 'slash commands (/model, /compress, /skills, /new) as backend API' },
  { hermes: 'website', sira: 'backend/src/routes/hermes.js, .agents/skills/technical-docs', status: 'integrated', strategy: 'integration map + health docs via /api/hermes/*' },
  { hermes: 'docker', sira: 'backend/src/services/agents/hermes-docker-bridge.js', status: 'integrated', strategy: 'Hermes backend profiles mapped to code-sandbox + env-gated remote backends' },
  { hermes: 'tests', sira: 'backend/tests, tests, e2e', status: 'integrated', strategy: 'map Hermes test lanes to Node --test suites' },
]);

const UPSTREAM_TO_SIRAGPT_SKILLS = Object.freeze({
  'systematic-debugging': ['runtime-debugging', 'bugfix-sweep'],
  'test-driven-development': ['qa-smoke-testing', 'agent-validation', 'quality-gates'],
  'writing-plans': ['technical-docs', 'repo-folder-integration'],
  plan: ['technical-docs', 'repo-folder-integration'],
  'subagent-driven-development': ['agent-validation', 'agent-capability-matrix'],
  'requesting-code-review': ['autoreview', 'quality-gates'],
  'hermes-agent-skill-authoring': ['technical-docs', 'hermes-import-audit'],
  'debugging-hermes-tui-commands': ['runtime-debugging'],
  'kanban-orchestrator': ['agent-capability-matrix', 'ci-orchestrator'],
  'kanban-worker': ['agent-validation', 'e2e-proof-recorder'],
  arxiv: ['qa-smoke-testing'],
  'research-paper-writing': ['technical-docs'],
  'webhook-subscriptions': ['channel-connector-hardening'],
  'node-inspect-debugger': ['runtime-debugging'],
  'python-debugpy': ['runtime-debugging'],
  spike: ['repo-folder-integration'],
  'macos-computer-use': ['agent-validation'],
  'jupyter-live-kernel': ['agent-validation', 'code_generation_tests'],
});

function parseSkillMarkdown(raw) {
  const text = String(raw || '');
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: text };
  }
  const frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) continue;
    frontmatter[pair[1]] = pair[2].replace(/^["']|["']$/g, '').trim();
  }
  return { frontmatter, body: match[2] };
}

function walkSkillFiles(rootDir, relativePrefix = '') {
  const skills = [];
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return skills;
    throw err;
  }

  for (const entry of entries) {
    const rel = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const skillPath = path.join(full, 'SKILL.md');
      if (fs.existsSync(skillPath)) {
        const raw = fs.readFileSync(skillPath, 'utf8');
        const parsed = parseSkillMarkdown(raw);
        skills.push({
          id: parsed.frontmatter.name || entry.name,
          folder: rel,
          description: parsed.frontmatter.description || firstHeading(raw) || '',
          path: skillPath,
          bodyChars: parsed.body.length,
          source: relativePrefix ? 'optional-skills' : 'skills',
        });
      } else {
        skills.push(...walkSkillFiles(full, rel));
      }
    }
  }
  return skills;
}

function loadFlatInstructionSkills(rootDir) {
  const skills = [];
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return skills;
    throw err;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(rootDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    const raw = fs.readFileSync(skillPath, 'utf8');
    const parsed = parseSkillMarkdown(raw);
    skills.push({
      id: parsed.frontmatter.name || entry.name,
      folder: entry.name,
      description: parsed.frontmatter.description || firstHeading(raw) || '',
      path: skillPath,
      bodyChars: parsed.body.length,
      source: 'sira',
    });
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

function loadHermesUpstreamSkills(upstreamRoot) {
  const skillsRoot = path.join(upstreamRoot, 'skills');
  const optionalRoot = path.join(upstreamRoot, 'optional-skills');
  const skills = [
    ...walkSkillFiles(skillsRoot, 'skills'),
    ...walkSkillFiles(optionalRoot, 'optional-skills'),
  ];
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

function buildHermesIntegrationMap(opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  const upstreamRoot = opts.upstreamRoot || path.join(repoRoot, '.agents', 'hermes-upstream');
  const siraSkillsRoot = opts.siraSkillsRoot || path.join(repoRoot, '.agents', 'skills');
  const upstreamSkills = loadHermesUpstreamSkills(upstreamRoot);
  const siraSkills = loadFlatInstructionSkills(siraSkillsRoot);
  const siraIds = new Set(siraSkills.map((skill) => skill.id));

  const skillCoverage = upstreamSkills.map((upstream) => {
    const mapped = UPSTREAM_TO_SIRAGPT_SKILLS[upstream.id] || [];
    const available = mapped.filter((id) => siraIds.has(id));
    return {
      upstream: upstream.id,
      folder: upstream.folder,
      source: upstream.source,
      description: upstream.description,
      adaptedSkills: mapped,
      availableSkills: available,
      status: available.length === mapped.length && mapped.length > 0
        ? 'covered'
        : mapped.length > 0
          ? 'partial'
          : 'reference-only',
    };
  });

  const coverageCounts = skillCoverage.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});

  let snapshotCommit = DEFAULT_SNAPSHOT_SHA;
  try {
    const snapshot = JSON.parse(fs.readFileSync(path.join(upstreamRoot, 'SNAPSHOT.json'), 'utf8'));
    if (snapshot.commit) snapshotCommit = snapshot.commit;
  } catch (_) {
    // keep default
  }

  return {
    source: {
      repository: 'https://github.com/NousResearch/hermes-agent',
      commit: opts.upstreamCommit || snapshotCommit,
      license: 'MIT',
      snapshot: '.agents/hermes-upstream',
    },
    counts: {
      upstreamSkills: upstreamSkills.length,
      siraSkills: siraSkills.length,
      foldersMapped: FOLDER_CAPABILITY_MAP.length,
      coverage: coverageCounts,
    },
    folders: [...FOLDER_CAPABILITY_MAP],
    skills: skillCoverage,
  };
}

function recommendAdaptedPlaybooks(query, opts = {}) {
  const terms = tokenize(query);
  const matrix = opts.matrix || buildHermesIntegrationMap(opts);
  if (terms.length === 0) return [];

  const scored = [];
  if (terms.some((term) => ['hermes', 'nous', 'copiar', 'copy', 'import', 'adaptar', 'integrar'].includes(term))) {
    scored.push({
      upstream: 'hermes-import-policy',
      adaptedSkills: ['hermes-import-audit', 'agent-capability-matrix', 'repo-folder-integration'],
      score: terms.length + 3,
      matchedTerms: terms,
    });
  }
  for (const item of matrix.skills) {
    const haystack = [
      item.upstream,
      item.folder,
      item.description,
      item.status,
      ...item.adaptedSkills,
      ...item.availableSkills,
    ].join(' ').toLowerCase();
    const matched = terms.filter((term) => haystack.includes(term));
    if (matched.length === 0) continue;
    scored.push({
      upstream: item.upstream,
      adaptedSkills: item.availableSkills,
      score: matched.length + (item.status === 'covered' ? 1 : 0),
      matchedTerms: matched,
    });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.upstream.localeCompare(b.upstream))
    .slice(0, opts.limit || 8);
}

function firstHeading(raw) {
  const line = String(raw || '').split(/\r?\n/).find((candidate) => candidate.startsWith('# '));
  return line ? line.replace(/^#\s+/, '').trim() : '';
}

function tokenize(input) {
  const stopWords = new Set(['con', 'los', 'las', 'para', 'por', 'que', 'the', 'and', 'with', 'from']);
  return String(input || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9_-]+/)
    .filter((term) => term.length >= 3 && !stopWords.has(term));
}

module.exports = {
  DEFAULT_SNAPSHOT_SHA,
  FOLDER_CAPABILITY_MAP,
  UPSTREAM_TO_SIRAGPT_SKILLS,
  parseSkillMarkdown,
  loadFlatInstructionSkills,
  loadHermesUpstreamSkills,
  buildHermesIntegrationMap,
  recommendAdaptedPlaybooks,
};
