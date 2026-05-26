'use strict';

/**
 * Platform folder parity — maps OpenClaw/Hermes top-level folders to SiraGPT.
 * Used by `npm run agent:platform:map` and folder bootstrap validation.
 */

const fs = require('fs');
const path = require('path');

const REQUIRED_TOP_LEVEL = Object.freeze([
  '.agents',
  '.github',
  '.vscode',
  'apps',
  'changelog',
  'config',
  'deploy',
  'docs',
  'extensions',
  'git-hooks',
  'packages',
  'patches',
  'qa',
  'scripts',
  'security',
  'skills',
  'src',
  'test',
  'ui',
]);

const FOLDER_PARITY_MAP = Object.freeze([
  { folder: '.agents', siraPaths: ['.agents', '.agents/skills', '.agents/openclaw-upstream', '.agents/hermes-upstream'], status: 'integrated', role: 'Agent skills, upstream snapshots, playbooks' },
  { folder: '.github', siraPaths: ['.github', '.github/workflows'], status: 'integrated', role: 'CI/CD, security scans, release automation' },
  { folder: '.vscode', siraPaths: ['.vscode'], status: 'integrated', role: 'Editor settings and launch configs' },
  { folder: 'apps', siraPaths: ['app', 'android', 'ios', 'extension'], status: 'integrated', role: 'Product surfaces (Next.js app, mobile, browser extension)' },
  { folder: 'changelog', siraPaths: ['changelog', 'CHANGELOG.md'], status: 'integrated', role: 'Release history and version notes' },
  { folder: 'config', siraPaths: ['config', 'package.json', 'tsconfig.json', 'backend/package.json'], status: 'integrated', role: 'Build, agent platform, and runtime configuration' },
  { folder: 'deploy', siraPaths: ['deploy', 'Dockerfile', 'docker-compose.yml', 'infra'], status: 'integrated', role: 'Containers, compose stacks, infra bridges' },
  { folder: 'docs', siraPaths: ['docs', 'CLAUDE.md', 'README-BACKEND.md'], status: 'integrated', role: 'Architecture, runbooks, operator docs' },
  { folder: 'extensions', siraPaths: ['extensions', 'extension', 'backend/src/services/agents/plugin-registry.js'], status: 'integrated', role: 'Plugins, connectors, and extension registry' },
  { folder: 'git-hooks', siraPaths: ['git-hooks', '.husky'], status: 'integrated', role: 'Pre-commit and git hook policies' },
  { folder: 'packages', siraPaths: ['packages', 'packages/sdk'], status: 'integrated', role: 'Shared packages and SDK' },
  { folder: 'patches', siraPaths: ['patches'], status: 'integrated', role: 'Dependency patch policy and overrides' },
  { folder: 'qa', siraPaths: ['qa', 'backend/tests', 'tests', 'e2e'], status: 'integrated', role: 'Smoke, unit, integration, and E2E lanes' },
  { folder: 'scripts', siraPaths: ['scripts', 'backend/scripts'], status: 'integrated', role: 'CLI tooling, maps, validation scripts' },
  { folder: 'security', siraPaths: ['security', 'SECURITY.md', '.gitleaks.toml', '.github/workflows'], status: 'integrated', role: 'Secret scanning, advisories, hardening' },
  { folder: 'skills', siraPaths: ['skills', '.agents/skills', 'backend/src/skills'], status: 'integrated', role: 'Active agent skills and handlers' },
  { folder: 'src', siraPaths: ['src', 'backend/src', 'lib'], status: 'integrated', role: 'Application and backend source roots' },
  { folder: 'test', siraPaths: ['test', 'backend/tests', 'tests'], status: 'integrated', role: 'Test suites and harnesses' },
  { folder: 'ui', siraPaths: ['ui', 'app', 'components', 'backend/src/routes/hermes.js'], status: 'integrated', role: 'UI surfaces + Hermes TUI protocol via /api/hermes/tui' },
]);

const HERMES_AGENT_FOLDERS = Object.freeze([
  { hermes: 'agent', sira: 'backend/src/services/agents/hermes-agent-bridge.js', status: 'integrated' },
  { hermes: 'gateway', sira: 'backend/src/services/agents/hermes-gateway-bridge.js', status: 'integrated' },
  { hermes: 'cron', sira: 'backend/src/services/agents/cron/hermes-cron-bridge.js', status: 'integrated' },
  { hermes: 'plugins', sira: 'backend/src/services/agents/hermes-plugin-bridge.js', status: 'integrated' },
  { hermes: 'tools', sira: 'backend/src/services/agents/hermes-tools.js', status: 'integrated' },
  { hermes: 'skills', sira: '.agents/hermes-upstream/skills', status: 'integrated' },
]);

function resolveRepoRoot(opts = {}) {
  return opts.repoRoot || process.cwd();
}

function pathExists(repoRoot, rel) {
  try {
    fs.accessSync(path.join(repoRoot, rel));
    return true;
  } catch {
    return false;
  }
}

function auditFolder(repoRoot, entry) {
  const resolved = [];
  const missing = [];
  for (const rel of entry.siraPaths) {
    if (pathExists(repoRoot, rel)) resolved.push(rel);
    else missing.push(rel);
  }
  const present = resolved.length > 0;
  return {
    folder: entry.folder,
    status: entry.status,
    role: entry.role,
    present,
    resolvedPaths: resolved,
    missingPaths: missing,
    coverage: resolved.length / entry.siraPaths.length,
  };
}

function buildPlatformFolderReport(opts = {}) {
  const repoRoot = resolveRepoRoot(opts);
  const folders = FOLDER_PARITY_MAP.map((entry) => auditFolder(repoRoot, entry));
  const required = REQUIRED_TOP_LEVEL.map((name) => ({
    name,
    exists: pathExists(repoRoot, name),
  }));

  const integrated = folders.filter((f) => f.present && f.status === 'integrated').length;
  const gaps = required.filter((r) => !r.exists).map((r) => r.name);

  return {
    source: {
      openclaw: 'https://github.com/openclaw/openclaw',
      hermes: 'https://github.com/NousResearch/hermes-agent',
      note: 'Top-level layout parity for SiraGPT agent platform',
    },
    counts: {
      requiredTopLevel: REQUIRED_TOP_LEVEL.length,
      presentTopLevel: required.filter((r) => r.exists).length,
      mappedFolders: folders.length,
      integrated,
      gaps: gaps.length,
    },
    gaps,
    required,
    folders,
    hermesAgentFolders: HERMES_AGENT_FOLDERS,
  };
}

function assertPlatformFolders(opts = {}) {
  const report = buildPlatformFolderReport(opts);
  if (report.gaps.length > 0) {
    const err = new Error(`Missing platform folders: ${report.gaps.join(', ')}`);
    err.report = report;
    throw err;
  }
  return report;
}

module.exports = {
  REQUIRED_TOP_LEVEL,
  FOLDER_PARITY_MAP,
  HERMES_AGENT_FOLDERS,
  buildPlatformFolderReport,
  assertPlatformFolders,
  pathExists,
};
