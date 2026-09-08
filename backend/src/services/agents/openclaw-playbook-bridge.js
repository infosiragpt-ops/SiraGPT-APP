'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const {
  buildPublicSkillCatalog,
  countPublicSkillCoverage,
} = require('./openclaw-public-skill-adapter');

const DEFAULT_SNAPSHOT_SHA = 'b56ddcc6ffdfc5be78c1c9c93926518367b876eb';
const ROOT_CONFIG_FILES = new Set([
  '.dockerignore',
  '.editorconfig',
  '.env.example',
  '.gitattributes',
  '.gitignore',
  '.npmrc',
  'AGENTS.md',
  'CLAUDE.md',
  'Dockerfile',
  'LICENSE',
  'Makefile',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'render.yaml',
  'tsconfig.json',
  'turbo.json',
  'vitest.config.ts',
]);

const FOLDER_CAPABILITY_MAP = Object.freeze([
  { openclaw: '.agents', sira: '.agents', status: 'integrated', strategy: 'upstream snapshot plus rewritten active skills' },
  { openclaw: '.claude', sira: 'AGENTS.md, .agents/skills', status: 'reference-only', strategy: 'translate portable instructions into SiraGPT agent contracts; never activate Claude-specific bootstrap code' },
  { openclaw: '.github', sira: '.github/workflows', status: 'partial', strategy: 'reuse CI patterns only after matching SiraGPT required checks' },
  { openclaw: '.vscode', sira: '.vscode', status: 'partial', strategy: 'developer ergonomics only; no runtime dependency' },
  { openclaw: 'apps', sira: 'app, android, ios, extension', status: 'protected', strategy: 'product/UI surface; use only when UI scope is explicit' },
  { openclaw: 'changelog/fragments', sira: 'CHANGELOG.md, docs/release-notes', status: 'planned', strategy: 'summarize only SiraGPT-facing release notes; do not import upstream release noise' },
  { openclaw: 'config', sira: 'config files, package.json, tsconfig', status: 'partial', strategy: 'port deterministic build defaults with type/build proof' },
  { openclaw: 'deploy', sira: 'infra, docker-compose.yml, scripts', status: 'partial', strategy: 'adapt deploy health checks and rollback probes' },
  { openclaw: 'docs', sira: 'docs, .agents/skills/technical-docs', status: 'integrated', strategy: 'rewrite as SiraGPT runbooks and operating contracts' },
  { openclaw: 'examples', sira: 'docs/examples, backend/tests/fixtures', status: 'reference-only', strategy: 'use examples as behavioral evidence; rewrite approved examples as SiraGPT fixtures or documentation' },
  { openclaw: 'extensions', sira: 'backend/src/services, extension, infra', status: 'partial', strategy: 'adapt connector/provider patterns behind backend contracts' },
  { openclaw: 'git-hooks', sira: '.husky, scripts', status: 'partial', strategy: 'keep only hooks that protect secrets, ignored staged paths, and deterministic checks' },
  { openclaw: 'packages', sira: 'backend/src, lib, scripts', status: 'partial', strategy: 'reuse utility ideas with focused tests' },
  { openclaw: 'patches', sira: 'patches, package-lock/npm-shrinkwrap policy', status: 'planned', strategy: 'review dependency patches and port only runtime-required fixes' },
  { openclaw: 'qa', sira: 'e2e, backend/tests, scripts', status: 'integrated', strategy: 'convert QA lanes into cheapest safe SiraGPT proof' },
  { openclaw: 'scripts', sira: 'scripts, backend/scripts', status: 'integrated', strategy: 'port idempotent CLIs with JSON output' },
  { openclaw: 'security', sira: 'docs/legal, scripts, .github/workflows', status: 'integrated', strategy: 'preserve secret scanning and advisory guardrails' },
  { openclaw: 'skills', sira: '.agents/skills, backend/skills', status: 'integrated', strategy: 'copy inactive upstream, activate rewritten SiraGPT skills' },
  { openclaw: 'src', sira: 'backend/src', status: 'partial', strategy: 'integrate runtime ideas through services and tests' },
  { openclaw: 'test', sira: 'backend/tests, tests, e2e', status: 'integrated', strategy: 'map test lanes to local and CI gates' },
  { openclaw: 'ui', sira: 'app, components', status: 'protected', strategy: 'guard with UI lock unless product scope is explicit' },
  { openclaw: 'root-config', sira: 'Dockerfile, render.yaml, tsconfig*, vitest.config.ts, npm-shrinkwrap.json', status: 'partial', strategy: 'merge build/test improvements only after local proof and CI compatibility' },
]);

const UPSTREAM_TO_SIRAGPT_SKILLS = Object.freeze({
  'agent-transcript': ['agent-transcript-lite'],
  'auto-qa': ['autoreview', 'qa-smoke-testing', 'e2e-proof-recorder', 'quality-gates'],
  autoreview: ['autoreview'],
  'channel-message-flows': ['message-flow-lab', 'channel-connector-hardening'],
  'claw-score': ['agent-capability-matrix', 'quality-gates'],
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
  'openclaw-changelog-update': ['release-maintainer', 'technical-docs'],
  'openclaw-ci-limits': ['ci-orchestrator', 'performance-profiler', 'quality-gates'],
  'openclaw-landable-bug-sweep': ['bugfix-sweep'],
  'openclaw-live-updater': ['release-maintainer', 'release-orchestrator', 'runtime-debugging', 'e2e-proof-recorder'],
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
  'release-openclaw-announcement': ['release-orchestrator', 'technical-docs'],
  'release-openclaw-mac': ['release-maintainer'],
  'release-openclaw-maintainer': ['release-maintainer'],
  'release-openclaw-nightly': ['release-maintainer', 'ci-orchestrator'],
  'release-openclaw-plugin-testing': ['agent-validation', 'qa-smoke-testing'],
  'security-triage': ['security-hardening'],
  slacrawl: ['channel-connector-hardening'],
  'tag-duplicate-prs-issues': ['repo-folder-integration'],
  'technical-documentation': ['technical-docs'],
  'telegram-crabbox-e2e-proof': ['e2e-proof-recorder', 'channel-connector-hardening'],
  'verify-release': ['release-orchestrator', 'quality-gates', 'ci-orchestrator'],
});

const UPSTREAM_REFERENCE_ONLY_SKILLS = Object.freeze([
  'discord-user-post',
]);

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

function normalizeGitRevision(value) {
  const revision = String(value || 'HEAD').trim();
  if (revision === 'HEAD' || /^[0-9a-f]{7,64}$/i.test(revision)) return revision;
  throw new Error('OpenClaw audit requires HEAD or a hexadecimal commit SHA');
}

function readGitReference(rootDir, revisionInput) {
  if (!rootDir || !fs.existsSync(path.join(rootDir, '.git'))) return null;
  try {
    const revision = normalizeGitRevision(revisionInput);
    const commit = childProcess.execFileSync('git', ['-C', rootDir, 'rev-parse', `${revision}^{commit}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1024 * 1024,
    }).trim();
    const raw = childProcess.execFileSync('git', ['-C', rootDir, 'ls-tree', '-r', '-z', commit, '--'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
    const entries = [];
    for (const record of raw.split('\0')) {
      if (!record) continue;
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const metadata = record.slice(0, tab).trim().split(/\s+/);
      if (metadata.length < 3 || metadata[1] !== 'blob') continue;
      entries.push({
        mode: metadata[0],
        object: metadata[2],
        path: record.slice(tab + 1),
      });
    }
    return { commit, entries };
  } catch {
    return null;
  }
}

function readGitText(rootDir, commit, relativePath, maxBytes = 1024 * 1024) {
  try {
    const raw = childProcess.execFileSync('git', ['-C', rootDir, 'show', `${commit}:${relativePath}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: maxBytes,
    });
    return raw.length <= maxBytes ? raw : '';
  } catch {
    return '';
  }
}

function loadInstructionSkillsFromGit(rootDir, commit, entries, skillsRoot) {
  const prefix = `${String(skillsRoot || '').replace(/^\/+|\/+$/g, '')}/`;
  const skills = [];
  for (const entry of entries || []) {
    if (!entry.path.startsWith(prefix) || !entry.path.endsWith('/SKILL.md')) continue;
    const relative = entry.path.slice(prefix.length);
    const parts = relative.split('/');
    if (parts.length !== 2 || parts[1] !== 'SKILL.md') continue;
    const raw = readGitText(rootDir, commit, entry.path);
    if (!raw) continue;
    const parsed = parseSkillMarkdown(raw);
    skills.push({
      id: parsed.frontmatter.name || parts[0],
      folder: parts[0],
      description: parsed.frontmatter.description || firstHeading(raw) || '',
      path: `${rootDir}@${commit}:${entry.path}`,
      bodyChars: parsed.body.length,
    });
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

function detectGitCommit(rootDir) {
  if (!rootDir) return null;
  try {
    return childProcess.execFileSync('git', ['-C', rootDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function countFiles(rootDir) {
  let total = 0;
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) total += 1;
    }
  }
  return total;
}

function rootFolderPath(rootDir, folderName) {
  if (folderName === 'root-config') return rootDir;
  return path.join(rootDir, folderName);
}

function createUnmappedFolderEntry(folder) {
  return {
    openclaw: folder,
    sira: 'manual review',
    status: 'unknown',
    strategy: 'inventory-only until a SiraGPT owner surface is assigned',
  };
}

function appendUnmappedFolders(baseMap, topLevelFolders) {
  const mappedTopLevels = new Set(baseMap.map((entry) => entry.openclaw.split('/')[0]));
  const extra = [...new Set(topLevelFolders || [])]
    .filter((folder) => folder && !mappedTopLevels.has(folder))
    .sort()
    .map(createUnmappedFolderEntry);
  return [...baseMap, ...extra];
}

function listWorkingTreeTopLevelFolders(rootDir) {
  try {
    return fs.readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !['.git', 'node_modules'].includes(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function scanFolderAudit(upstreamRepoRoot) {
  const map = appendUnmappedFolders(
    FOLDER_CAPABILITY_MAP,
    upstreamRepoRoot ? listWorkingTreeTopLevelFolders(upstreamRepoRoot) : [],
  );
  if (!upstreamRepoRoot) {
    return map.map((entry) => ({
      ...entry,
      upstream_exists: null,
      upstream_file_count: null,
    }));
  }
  return map.map((entry) => {
    const target = rootFolderPath(upstreamRepoRoot, entry.openclaw);
    const exists = entry.openclaw === 'root-config'
      ? [...ROOT_CONFIG_FILES].some((file) => fs.existsSync(path.join(upstreamRepoRoot, file)))
      : fs.existsSync(target);
    const fileCount = entry.openclaw === 'root-config'
      ? [...ROOT_CONFIG_FILES].filter((file) => fs.existsSync(path.join(upstreamRepoRoot, file))).length
      : exists
        ? countFiles(target)
        : 0;
    return {
      ...entry,
      upstream_exists: exists,
      upstream_file_count: fileCount,
    };
  });
}

function scanGitFolderAudit(entries) {
  const topLevelFolders = (entries || [])
    .map((entry) => entry.path.split('/'))
    .filter((parts) => parts.length > 1)
    .map((parts) => parts[0]);
  const map = appendUnmappedFolders(FOLDER_CAPABILITY_MAP, topLevelFolders);
  return map.map((entry) => {
    const selected = entry.openclaw === 'root-config'
      ? entries.filter((candidate) => !candidate.path.includes('/') && ROOT_CONFIG_FILES.has(candidate.path))
      : entries.filter((candidate) => candidate.path.startsWith(`${entry.openclaw}/`));
    return {
      ...entry,
      upstream_exists: selected.length > 0,
      upstream_file_count: selected.length,
    };
  });
}

function buildOpenClawIntegrationMap(opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  const upstreamRepoRoot = opts.upstreamRepoRoot || null;
  const gitReference = upstreamRepoRoot
    ? readGitReference(upstreamRepoRoot, opts.upstreamCommit || 'HEAD')
    : null;
  if (opts.requireGitTree === true && !gitReference) {
    throw new Error(`Unable to audit the requested OpenClaw Git tree at ${upstreamRepoRoot}`);
  }
  const upstreamSkillsRoot = opts.upstreamSkillsRoot || (upstreamRepoRoot
    ? path.join(upstreamRepoRoot, '.agents', 'skills')
    : path.join(repoRoot, '.agents', 'openclaw-upstream', 'skills'));
  const upstreamPublicSkillsRoot = opts.upstreamPublicSkillsRoot || (upstreamRepoRoot
    ? path.join(upstreamRepoRoot, 'skills')
    : null);
  const siraSkillsRoot = opts.siraSkillsRoot || path.join(repoRoot, '.agents', 'skills');
  const upstreamSkills = gitReference
    ? loadInstructionSkillsFromGit(upstreamRepoRoot, gitReference.commit, gitReference.entries, '.agents/skills')
    : loadInstructionSkills(upstreamSkillsRoot);
  const upstreamPublicSkills = gitReference
    ? loadInstructionSkillsFromGit(upstreamRepoRoot, gitReference.commit, gitReference.entries, 'skills')
    : upstreamPublicSkillsRoot
      ? loadInstructionSkills(upstreamPublicSkillsRoot)
      : [];
  const siraSkills = loadInstructionSkills(siraSkillsRoot);
  const siraIds = new Set(siraSkills.map((skill) => skill.id));

  const skillCoverage = upstreamSkills.map((upstream) => {
    const mapped = UPSTREAM_TO_SIRAGPT_SKILLS[upstream.id] || [];
    const available = mapped.filter((id) => siraIds.has(id));
    const explicitlyReferenceOnly = UPSTREAM_REFERENCE_ONLY_SKILLS.includes(upstream.id);
    return {
      upstream: upstream.id,
      description: upstream.description,
      adaptedSkills: mapped,
      availableSkills: available,
      status: explicitlyReferenceOnly
        ? 'reference-only'
        : available.length === mapped.length && mapped.length > 0
        ? 'covered'
        : mapped.length > 0
          ? 'partial'
          : 'reference-only',
      reason: explicitlyReferenceOnly
        ? 'Direct external posting requires an authenticated user session and action-time approval; it is never activated by import.'
        : null,
    };
  });

  const coverageCounts = skillCoverage.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});
  const publicSkillCatalog = buildPublicSkillCatalog(upstreamPublicSkills, { repoRoot });
  const folders = gitReference
    ? scanGitFolderAudit(gitReference.entries)
    : scanFolderAudit(upstreamRepoRoot);

  return {
    source: {
      repository: 'https://github.com/openclaw/openclaw',
      commit: gitReference?.commit || opts.upstreamCommit || detectGitCommit(upstreamRepoRoot) || DEFAULT_SNAPSHOT_SHA,
      license: 'MIT',
      snapshot: upstreamRepoRoot ? 'external-reference-only' : '.agents/openclaw-upstream',
      audit_root: upstreamRepoRoot || null,
      inventory_mode: gitReference ? 'git_tree' : 'working_tree',
      tracked_files: gitReference ? gitReference.entries.length : null,
      inventory_coverage_percent: gitReference ? 100 : null,
    },
    counts: {
      upstreamSkills: upstreamSkills.length,
      upstreamPublicSkills: upstreamPublicSkills.length,
      siraSkills: siraSkills.length,
      foldersMapped: folders.length,
      configuredFolders: FOLDER_CAPABILITY_MAP.length,
      unmappedFolders: folders.filter((folder) => folder.status === 'unknown').length,
      coverage: coverageCounts,
      publicSkillCoverage: countPublicSkillCoverage(publicSkillCatalog),
    },
    folders,
    skills: skillCoverage,
    public_skills: publicSkillCatalog,
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
  for (const item of matrix.public_skills || []) {
    const haystack = [
      item.upstream,
      item.description,
      item.status,
      item.reason,
      ...(item.adaptedSkills || []),
      ...(item.availableSkills || []),
    ].join(' ').toLowerCase();
    const matched = terms.filter((term) => haystack.includes(term));
    if (matched.length === 0) continue;
    scored.push({
      upstream: item.upstream,
      adaptedSkills: item.availableSkills || [],
      score: matched.length + (item.status === 'covered' ? 2 : item.status === 'adapted' ? 1 : 0),
      matchedTerms: matched,
      status: item.status,
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
  UPSTREAM_REFERENCE_ONLY_SKILLS,
  parseSkillMarkdown,
  loadInstructionSkills,
  loadInstructionSkillsFromGit,
  buildOpenClawIntegrationMap,
  recommendAdaptedPlaybooks,
};
