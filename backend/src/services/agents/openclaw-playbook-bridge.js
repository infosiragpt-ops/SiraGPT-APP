'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_SNAPSHOT_SHA = 'b56ddcc6ffdfc5be78c1c9c93926518367b876eb';

const FOLDER_CAPABILITY_MAP = Object.freeze([
  { openclaw: '.agents', sira: '.agents', status: 'integrated', strategy: 'upstream snapshot plus rewritten active skills' },
  { openclaw: '.github', sira: '.github/workflows', status: 'partial', strategy: 'reuse CI patterns only after matching SiraGPT required checks' },
  { openclaw: '.vscode', sira: '.vscode', status: 'partial', strategy: 'developer ergonomics only; no runtime dependency' },
  { openclaw: 'apps', sira: 'app, android, ios, extension', status: 'protected', strategy: 'product/UI surface; use only when UI scope is explicit' },
  { openclaw: 'config', sira: 'config files, package.json, tsconfig', status: 'partial', strategy: 'port deterministic build defaults with type/build proof' },
  { openclaw: 'deploy', sira: 'infra, docker-compose.yml, scripts', status: 'partial', strategy: 'adapt deploy health checks and rollback probes' },
  { openclaw: 'docs', sira: 'docs, .agents/skills/technical-docs', status: 'integrated', strategy: 'rewrite as SiraGPT runbooks and operating contracts' },
  { openclaw: 'extensions', sira: 'backend/src/services, extension, infra', status: 'partial', strategy: 'adapt connector/provider patterns behind backend contracts' },
  { openclaw: 'packages', sira: 'backend/src, lib, scripts', status: 'partial', strategy: 'reuse utility ideas with focused tests' },
  { openclaw: 'qa', sira: 'e2e, backend/tests, scripts', status: 'integrated', strategy: 'convert QA lanes into cheapest safe SiraGPT proof' },
  { openclaw: 'scripts', sira: 'scripts, backend/scripts', status: 'integrated', strategy: 'port idempotent CLIs with JSON output' },
  { openclaw: 'security', sira: 'docs/legal, scripts, .github/workflows', status: 'integrated', strategy: 'preserve secret scanning and advisory guardrails' },
  { openclaw: 'skills', sira: '.agents/skills, backend/skills', status: 'integrated', strategy: 'copy inactive upstream, activate rewritten SiraGPT skills' },
  { openclaw: 'src', sira: 'backend/src', status: 'partial', strategy: 'integrate runtime ideas through services and tests' },
  { openclaw: 'test', sira: 'backend/tests, tests, e2e', status: 'integrated', strategy: 'map test lanes to local and CI gates' },
  { openclaw: 'ui', sira: 'app, components', status: 'protected', strategy: 'guard with UI lock unless product scope is explicit' },
]);

const UPSTREAM_TO_SIRAGPT_SKILLS = Object.freeze({
  'agent-transcript': ['agent-transcript-lite'],
  autoreview: ['autoreview'],
  'channel-message-flows': ['message-flow-lab', 'channel-connector-hardening'],
  clawdtributor: ['repo-folder-integration', 'agent-capability-matrix'],
  clawsweeper: ['bugfix-sweep', 'release-maintainer'],
  'control-ui-e2e': ['e2e-proof-recorder', 'qa-smoke-testing'],
  crabbox: ['ci-orchestrator', 'e2e-proof-recorder'],
  'discord-clawd': ['channel-connector-hardening'],
  discrawl: ['channel-connector-hardening'],
  gitcrawl: ['repo-folder-integration', 'ci-orchestrator'],
  graincrawl: ['channel-connector-hardening'],
  notcrawl: ['channel-connector-hardening'],
  'openclaw-debugging': ['runtime-debugging'],
  'openclaw-docker-e2e-authoring': ['dependency-upgrade-guard', 'e2e-proof-recorder'],
  'openclaw-ghsa-maintainer': ['security-hardening', 'secret-safety'],
  'openclaw-landable-bug-sweep': ['bugfix-sweep'],
  'openclaw-parallels-smoke': ['e2e-proof-recorder'],
  'openclaw-pr-maintainer': ['release-maintainer', 'ci-orchestrator'],
  'openclaw-qa-testing': ['qa-smoke-testing', 'e2e-proof-recorder'],
  'openclaw-refactor-docs': ['technical-docs'],
  'openclaw-secret-scanning-maintainer': ['secret-safety', 'security-hardening'],
  'openclaw-small-bugfix-sweep': ['bugfix-sweep'],
  'openclaw-test-heap-leaks': ['performance-profiler'],
  'openclaw-test-performance': ['performance-profiler'],
  'openclaw-testing': ['qa-smoke-testing', 'quality-gates'],
  'parallels-discord-roundtrip': ['e2e-proof-recorder', 'channel-connector-hardening'],
  'release-openclaw-ci': ['ci-orchestrator', 'release-maintainer'],
  'release-openclaw-mac': ['release-maintainer'],
  'release-openclaw-maintainer': ['release-maintainer'],
  'release-openclaw-nightly': ['release-maintainer', 'ci-orchestrator'],
  'release-openclaw-plugin-testing': ['agent-validation', 'qa-smoke-testing'],
  'security-triage': ['security-hardening'],
  slacrawl: ['channel-connector-hardening'],
  'tag-duplicate-prs-issues': ['repo-folder-integration'],
  'technical-documentation': ['technical-docs'],
  'telegram-crabbox-e2e-proof': ['e2e-proof-recorder', 'channel-connector-hardening'],
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

function loadInstructionSkills(rootDir) {
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
    });
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

function buildOpenClawIntegrationMap(opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  const upstreamSkillsRoot = opts.upstreamSkillsRoot || path.join(repoRoot, '.agents', 'openclaw-upstream', 'skills');
  const siraSkillsRoot = opts.siraSkillsRoot || path.join(repoRoot, '.agents', 'skills');
  const upstreamSkills = loadInstructionSkills(upstreamSkillsRoot);
  const siraSkills = loadInstructionSkills(siraSkillsRoot);
  const siraIds = new Set(siraSkills.map((skill) => skill.id));

  const skillCoverage = upstreamSkills.map((upstream) => {
    const mapped = UPSTREAM_TO_SIRAGPT_SKILLS[upstream.id] || [];
    const available = mapped.filter((id) => siraIds.has(id));
    return {
      upstream: upstream.id,
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

  return {
    source: {
      repository: 'https://github.com/openclaw/openclaw',
      commit: opts.upstreamCommit || DEFAULT_SNAPSHOT_SHA,
      license: 'MIT',
      snapshot: '.agents/openclaw-upstream',
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
  const matrix = opts.matrix || buildOpenClawIntegrationMap(opts);
  if (terms.length === 0) return [];

  const scored = [];
  if (terms.some((term) => ['openclaw', 'copy', 'copiar', 'license', 'licencia', 'mit', 'import', 'adaptar'].includes(term))) {
    scored.push({
      upstream: 'openclaw-import-policy',
      adaptedSkills: ['openclaw-import-audit', 'agent-capability-matrix', 'repo-folder-integration'],
      score: terms.length + 3,
      matchedTerms: terms,
    });
  }
  for (const item of matrix.skills) {
    const haystack = [
      item.upstream,
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
  loadInstructionSkills,
  buildOpenClawIntegrationMap,
  recommendAdaptedPlaybooks,
};
