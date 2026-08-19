#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
const readText = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const rootPackage = readJson('package.json');
const backendPackage = readJson('backend/package.json');

function fileExists(id, relativePath) {
  return {
    id,
    category: 'repository-files',
    description: `${relativePath} exists`,
    pass: () => fs.existsSync(path.join(ROOT, relativePath)),
  };
}

function rootScript(id, scriptName) {
  return {
    id,
    category: 'root-scripts',
    description: `root package exposes npm script ${scriptName}`,
    pass: () => typeof rootPackage.scripts?.[scriptName] === 'string' && rootPackage.scripts[scriptName].length > 0,
  };
}

function rootDependency(id, packageName) {
  return {
    id,
    category: 'root-dependencies',
    description: `root package declares ${packageName}`,
    pass: () => Boolean(rootPackage.dependencies?.[packageName] || rootPackage.devDependencies?.[packageName]),
  };
}

function backendCapability(id, label, predicate) {
  return {
    id,
    category: 'backend-capabilities',
    description: label,
    pass: predicate,
  };
}

function workflowContains(id, token) {
  return {
    id,
    category: 'ci-workflow',
    description: `CI workflow contains ${token}`,
    pass: () => readText('.github/workflows/ci.yml').includes(token),
  };
}

const checks = [
  // 30 repository structure checks.
  fileExists('file-001-root-package', 'package.json'),
  fileExists('file-002-root-lockfile', 'package-lock.json'),
  fileExists('file-003-backend-package', 'backend/package.json'),
  fileExists('file-004-backend-lockfile', 'backend/package-lock.json'),
  fileExists('file-005-frontend-dockerfile', 'Dockerfile'),
  fileExists('file-006-backend-dockerfile', 'backend/Dockerfile'),
  fileExists('file-007-compose-dev', 'docker-compose.yml'),
  fileExists('file-008-compose-prod', 'docker-compose.prod.yml'),
  fileExists('file-009-ci-workflow', '.github/workflows/ci.yml'),
  fileExists('file-010-gitleaks-config', '.gitleaks.toml'),
  fileExists('file-011-next-config', 'next.config.mjs'),
  fileExists('file-012-tailwind-config', 'tailwind.config.js'),
  fileExists('file-013-playwright-config', 'playwright.config.ts'),
  fileExists('file-014-vitest-config', 'vitest.config.ts'),
  fileExists('file-015-root-tsconfig', 'tsconfig.json'),
  fileExists('file-016-tests-tsconfig', 'tests/tsconfig.json'),
  fileExists('file-017-postcss-config', 'postcss.config.mjs'),
  fileExists('file-018-drizzle-config', 'drizzle.config.ts'),
  fileExists('file-019-capacitor-config', 'capacitor.config.ts'),
  fileExists('file-020-readme', 'README.md'),
  fileExists('file-021-license-report', 'THIRD_PARTY_LICENSES.md'),
  fileExists('file-022-app-layout', 'app/layout.tsx'),
  fileExists('file-023-app-home', 'app/page.tsx'),
  fileExists('file-024-api-health', 'app/api/health/route.ts'),
  fileExists('file-025-auth-lib', 'lib/auth.ts'),
  fileExists('file-026-sse-client', 'lib/sse-client.ts'),
  fileExists('file-027-webhook-verify', 'lib/integrations/verify-webhook.ts'),
  fileExists('file-028-backend-index', 'backend/index.js'),
  fileExists('file-029-backend-prisma-schema', 'backend/prisma/schema.prisma'),
  fileExists('file-030-sdk-package', 'packages/sdk/package.json'),

  // 25 root npm script checks.
  rootScript('script-031-dev', 'dev'),
  rootScript('script-032-build', 'build'),
  rootScript('script-033-build-backend', 'build:backend'),
  rootScript('script-034-postbuild-slim', 'postbuild:slim'),
  rootScript('script-035-start', 'start'),
  rootScript('script-036-start-next-only', 'start:next-only'),
  rootScript('script-037-lint', 'lint'),
  rootScript('script-038-lint-count', 'lint:count'),
  rootScript('script-039-clean', 'clean'),
  rootScript('script-040-clean-all', 'clean:all'),
  rootScript('script-041-pretest', 'pretest'),
  rootScript('script-042-test', 'test'),
  rootScript('script-043-test-unit', 'test:unit'),
  rootScript('script-044-test-e2e', 'test:e2e'),
  rootScript('script-045-test-e2e-install', 'test:e2e:install'),
  rootScript('script-046-test-all', 'test:all'),
  rootScript('script-047-type-check', 'type-check'),
  rootScript('script-048-docker-up', 'docker:up'),
  rootScript('script-049-docker-down', 'docker:down'),
  rootScript('script-050-docker-rebuild', 'docker:rebuild'),
  rootScript('script-051-licenses-report', 'licenses:report'),
  rootScript('script-052-licenses-check', 'licenses:check'),
  rootScript('script-053-security-validate', 'security:validate'),
  rootScript('script-054-sbom-generate', 'sbom:generate'),
  rootScript('script-055-quality-100', 'quality:100'),

  // 20 frontend/runtime dependency checks.
  rootDependency('dep-056-next', 'next'),
  rootDependency('dep-057-react', 'react'),
  rootDependency('dep-058-react-dom', 'react-dom'),
  rootDependency('dep-059-typescript', 'typescript'),
  rootDependency('dep-060-eslint-next', 'eslint-config-next'),
  rootDependency('dep-061-playwright', '@playwright/test'),
  rootDependency('dep-062-vitest', 'vitest'),
  rootDependency('dep-063-zod', 'zod'),
  rootDependency('dep-064-ai-sdk', 'ai'),
  rootDependency('dep-065-axios', 'axios'),
  rootDependency('dep-066-dompurify', 'dompurify'),
  rootDependency('dep-067-next-intl', 'next-intl'),
  rootDependency('dep-068-next-auth', 'next-auth'),
  rootDependency('dep-069-sentry-browser', '@sentry/browser'),
  rootDependency('dep-070-posthog', 'posthog-js'),
  rootDependency('dep-071-shiki', 'shiki'),
  rootDependency('dep-072-react-markdown', 'react-markdown'),
  rootDependency('dep-073-rehype-sanitize', 'rehype-sanitize'),
  rootDependency('dep-074-tailwindcss', 'tailwindcss'),
  rootDependency('dep-075-husky', 'husky'),

  // 15 backend capability checks.
  backendCapability('backend-076-start-script', 'backend package exposes start script', () => typeof backendPackage.scripts?.start === 'string'),
  backendCapability('backend-077-test-script', 'backend package exposes test script', () => typeof backendPackage.scripts?.test === 'string'),
  backendCapability('backend-078-shard-script', 'backend package exposes test:shard script', () => typeof backendPackage.scripts?.['test:shard'] === 'string'),
  backendCapability('backend-079-coverage-script', 'backend package exposes coverage script', () => typeof backendPackage.scripts?.['test:coverage'] === 'string'),
  backendCapability('backend-080-db-generate-script', 'backend package exposes db:generate script', () => typeof backendPackage.scripts?.['db:generate'] === 'string'),
  backendCapability('backend-081-db-push-script', 'backend package exposes db:push script', () => typeof backendPackage.scripts?.['db:push'] === 'string'),
  backendCapability('backend-082-openapi-script', 'backend package exposes OpenAPI generation', () => typeof backendPackage.scripts?.['generate:openapi'] === 'string'),
  backendCapability('backend-083-express-dep', 'backend declares express', () => Boolean(backendPackage.dependencies?.express)),
  backendCapability('backend-084-prisma-cli-dep', 'backend declares prisma CLI', () => Boolean(backendPackage.dependencies?.prisma || backendPackage.devDependencies?.prisma)),
  backendCapability('backend-085-prisma-client-dep', 'backend declares @prisma/client', () => Boolean(backendPackage.dependencies?.['@prisma/client'])),
  backendCapability('backend-086-langgraph-dep', 'backend declares LangGraph', () => Boolean(backendPackage.dependencies?.['@langchain/langgraph'])),
  backendCapability('backend-087-openai-dep', 'backend declares openai', () => Boolean(backendPackage.dependencies?.openai)),
  backendCapability('backend-088-pg-dep', 'backend declares pg', () => Boolean(backendPackage.dependencies?.pg)),
  backendCapability('backend-089-bullmq-dep', 'backend declares bullmq', () => Boolean(backendPackage.dependencies?.bullmq)),
  backendCapability('backend-090-zod-dep', 'backend declares zod', () => Boolean(backendPackage.dependencies?.zod)),

  // 10 CI hardening checks.
  workflowContains('ci-091-frontend-build', 'Frontend · build'),
  workflowContains('ci-092-backend-smoke', 'Backend · prisma + boot smoke test'),
  workflowContains('ci-093-license-audit', 'Licenses · third-party audit'),
  workflowContains('ci-094-gitleaks', 'Secret scan · gitleaks audit'),
  workflowContains('ci-095-ui-lock', 'UI lock · verify zero visual-surface changes'),
  workflowContains('ci-096-docker-build', 'Docker · build images'),
  workflowContains('ci-097-playwright-smoke', 'E2E · Playwright smoke'),
  workflowContains('ci-098-visual-regression', 'Visual regression · pixel-perfect snapshots'),
  workflowContains('ci-099-required-checks', 'CI · required checks passed'),
  workflowContains('ci-100-node24', "NODE_VERSION: '24'"),
];

function runChecks() {
  if (checks.length !== 100) {
    throw new Error(`quality gate is misconfigured: expected 100 checks, got ${checks.length}`);
  }

  const seen = new Set();
  const results = checks.map((check) => {
    if (seen.has(check.id)) {
      return { ...check, status: 'fail', message: `duplicate check id ${check.id}` };
    }
    seen.add(check.id);

    try {
      const passed = Boolean(check.pass());
      return {
        id: check.id,
        category: check.category,
        description: check.description,
        status: passed ? 'pass' : 'fail',
        message: passed ? 'ok' : 'expectation was not met',
      };
    } catch (error) {
      return {
        id: check.id,
        category: check.category,
        description: check.description,
        status: 'fail',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });

  const failed = results.filter((check) => check.status !== 'pass');
  return {
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    checks: results,
  };
}

function main() {
  const report = runChecks();
  const asJson = process.argv.includes('--json');

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(`[quality:100] ${report.passed}/${report.total} checks passed`);
    for (const check of report.checks) {
      const mark = check.status === 'pass' ? '✓' : '✖';
      console.log(`${mark} ${check.id} ${check.description}`);
      if (check.status !== 'pass') console.log(`  ${check.message}`);
    }
  }

  if (report.failed > 0) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = { runChecks, checks };
