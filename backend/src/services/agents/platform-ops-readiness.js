'use strict';

/**
 * Operational readiness map for the SiraGPT agent platform.
 *
 * This rewrites the useful idea from OpenClaw's config/deploy/security/qa
 * folders into a SiraGPT-native readiness report. It checks whether the repo
 * has the scripts, configs, workflows, and docs needed to operate the agent
 * runtime professionally.
 */

const fs = require('fs');
const path = require('path');

const READINESS_LANES = Object.freeze([
  {
    id: 'config',
    label: 'Configuration',
    required: ['config/agent-platform.yaml', '.env.example', 'package.json', 'backend/package.json'],
  },
  {
    id: 'deploy',
    label: 'Deployment',
    required: ['Dockerfile', 'docker-compose.yml', '.github/workflows/deploy.yml', 'scripts/deploy-check.sh', 'scripts/verify-production.sh'],
  },
  {
    id: 'security',
    label: 'Security',
    required: ['SECURITY.md', '.gitleaks.toml', 'scripts/check-secrets.sh', 'scripts/validate-supply-chain.js', '.github/workflows/codeql.yml'],
  },
  {
    id: 'qa',
    label: 'Quality gates',
    required: ['backend/tests', 'tests', 'e2e', 'scripts/quality-100-checks.js', 'scripts/local-chat-recovery.js'],
  },
  {
    id: 'automation',
    label: 'Automation',
    required: ['.github/workflows/ci.yml', '.github/workflows/replit-sync.yml', 'scripts/configure-branch-protection.sh'],
  },
]);

function exists(repoRoot, relPath) {
  try {
    fs.accessSync(path.join(repoRoot, relPath));
    return true;
  } catch {
    return false;
  }
}

function auditLane(repoRoot, lane) {
  const checks = lane.required.map((relPath) => ({
    path: relPath,
    exists: exists(repoRoot, relPath),
  }));
  const passed = checks.filter((check) => check.exists).length;
  return {
    id: lane.id,
    label: lane.label,
    passed,
    total: checks.length,
    score: checks.length === 0 ? 1 : passed / checks.length,
    missing: checks.filter((check) => !check.exists).map((check) => check.path),
    checks,
  };
}

function buildOpsReadinessReport(opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  const lanes = READINESS_LANES.map((lane) => auditLane(repoRoot, lane));
  const passed = lanes.reduce((sum, lane) => sum + lane.passed, 0);
  const total = lanes.reduce((sum, lane) => sum + lane.total, 0);
  const missing = lanes.flatMap((lane) => lane.missing.map((item) => `${lane.id}:${item}`));
  return {
    source: {
      policy: 'SiraGPT-native operational readiness map; upstream scripts are not vendored.',
      upstreamReference: 'https://github.com/openclaw/openclaw',
    },
    counts: {
      lanes: lanes.length,
      passed,
      total,
      missing: missing.length,
    },
    score: total === 0 ? 1 : passed / total,
    status: missing.length === 0 ? 'ready' : 'partial',
    missing,
    lanes,
  };
}

function assertOpsReady(opts = {}) {
  const report = buildOpsReadinessReport(opts);
  if (report.missing.length > 0) {
    const err = new Error(`Operational readiness gaps: ${report.missing.join(', ')}`);
    err.report = report;
    throw err;
  }
  return report;
}

module.exports = {
  READINESS_LANES,
  buildOpsReadinessReport,
  assertOpsReady,
};
