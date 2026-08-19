'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  validateStartupEnvironment,
  Severity,
} = require('../src/utils/startup-validator');
const health = require('../src/services/observability/health-check');
const backendPackage = require('../package.json');

const ROOT = path.resolve(__dirname, '../..');
const MCP_KEYS = Object.freeze([
  'SIRAGPT_MCP_ALLOWED_HOSTS',
  'SIRAGPT_MCP_ALLOW_HTTP',
]);
const MCP_TESTS = Object.freeze([
  'tests/mcp-security-policy.test.js',
  'tests/mcp-runtime-security.test.js',
  'tests/mcp-security-route.test.js',
  'tests/mcp-security-config.test.js',
]);

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function strongSecret() {
  return 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
}

function baseEnv(overrides = {}) {
  return {
    NODE_ENV: 'production',
    JWT_SECRET: strongSecret(),
    SESSION_SECRET: strongSecret(),
    PRISMA_DATABASE_URL: 'postgresql://user:pass@db:5432/app',
    REDIS_URL: 'redis://redis:6379',
    RATE_LIMIT_STORE: 'redis',
    RATE_LIMIT_SENSITIVE_POLICY: 'distributed',
    CORS_ORIGINS: 'https://app.example.com',
    SENTRY_DSN: 'https://public@example.ingest.sentry.io/1',
    SIRAGPT_MCP_ALLOWED_HOSTS: 'mcp.example.com,*.tools.example.com',
    SIRAGPT_MCP_ALLOW_HTTP: '0',
    ...overrides,
  };
}

function startupIssues(env) {
  const logger = require('../src/middleware/logger').logger;
  const original = {
    info: logger.info,
    warn: logger.warn,
    error: logger.error,
  };
  const originalConsoleError = console.error;
  logger.info = () => {};
  logger.warn = () => {};
  logger.error = () => {};
  console.error = () => {};
  try {
    return validateStartupEnvironment(env, { failOnBlocking: false });
  } finally {
    Object.assign(logger, original);
    console.error = originalConsoleError;
  }
}

test('startup validation degrades missing production MCP policy but blocks malformed/insecure policy', () => {
  const missing = startupIssues(baseEnv({ SIRAGPT_MCP_ALLOWED_HOSTS: '' }));
  const required = missing.find((entry) => entry.code === 'MCP_ALLOWED_HOSTS_REQUIRED');
  assert.ok(required);
  assert.equal(required.severity, Severity.WARNING);

  const invalid = startupIssues(baseEnv({ SIRAGPT_MCP_ALLOWED_HOSTS: '*.co.uk' }));
  const malformed = invalid.find((entry) => entry.code === 'MCP_ALLOWED_HOSTS_INVALID');
  assert.ok(malformed);
  assert.equal(malformed.severity, Severity.BLOCKING);
  assert.doesNotMatch(JSON.stringify(malformed), /co\.uk/i);

  const insecureHttp = startupIssues(baseEnv({ SIRAGPT_MCP_ALLOW_HTTP: '1' }));
  const http = insecureHttp.find((entry) => entry.code === 'MCP_HTTP_FORBIDDEN_PRODUCTION');
  assert.ok(http);
  assert.equal(http.severity, Severity.BLOCKING);
});

test('startup validation permits an omitted development allowlist and warns on malformed configured policy', () => {
  const omitted = startupIssues(baseEnv({
    NODE_ENV: 'development',
    SIRAGPT_MCP_ALLOWED_HOSTS: '',
    SIRAGPT_MCP_ALLOW_HTTP: '1',
  }));
  assert.equal(omitted.some((entry) => String(entry.code || '').startsWith('MCP_')), false);

  const malformed = startupIssues(baseEnv({
    NODE_ENV: 'development',
    SIRAGPT_MCP_ALLOWED_HOSTS: '*.com',
  }));
  const issue = malformed.find((entry) => entry.code === 'MCP_ALLOWED_HOSTS_INVALID');
  assert.ok(issue);
  assert.equal(issue.severity, Severity.WARNING);
});

test('health reports MCP policy readiness without disclosing configured hosts', async () => {
  assert.equal(typeof health.checkMcpPolicyConfiguration, 'function');
  const env = baseEnv();
  const check = health.checkMcpPolicyConfiguration(env);
  assert.equal(check.name, 'mcp_policy');
  assert.equal(check.status, 'healthy');
  assert.equal(check.critical, true);
  assert.equal(check.details.allowed_host_count, 2);
  assert.equal(check.details.https_required, true);
  assert.doesNotMatch(JSON.stringify(check), /mcp\.example\.com|tools\.example\.com/i);

  const invalid = health.checkMcpPolicyConfiguration(baseEnv({
    SIRAGPT_MCP_ALLOWED_HOSTS: '',
  }));
  assert.equal(invalid.status, 'degraded');
  assert.equal(invalid.critical, false);
  assert.equal(invalid.details.deny_all, true);
  assert.deepEqual(invalid.details.error_codes, ['MCP_ALLOWED_HOSTS_REQUIRED']);

  const report = await health.runFullHealthCheck({ env });
  assert.ok(report.checks.some((entry) => entry.name === 'mcp_policy'));
});

test('MCP security controls are documented and passed through Compose safely', () => {
  const rootExample = read('.env.example');
  const backendExample = read('backend/.env.example');
  const reference = read('docs/ENV_VARIABLES.md');
  const operations = read('docs/operations/ENVIRONMENT.md');
  const localCompose = read('docker-compose.yml');
  const productionCompose = read('docker-compose.prod.yml');

  for (const key of MCP_KEYS) {
    assert.match(rootExample, new RegExp(`^${key}=`, 'm'));
    assert.match(backendExample, new RegExp(`^${key}=`, 'm'));
    assert.ok(reference.includes(`\`${key}\``), `ENV_VARIABLES.md missing ${key}`);
    assert.ok(operations.includes(`\`${key}\``), `operations docs missing ${key}`);
    assert.match(localCompose, new RegExp(`^\\s+${key}:`, 'm'));
    assert.match(productionCompose, new RegExp(`^\\s+${key}:`, 'm'));
  }
  assert.match(
    productionCompose,
    /SIRAGPT_MCP_ALLOWED_HOSTS:\s*["']?\$\{SIRAGPT_MCP_ALLOWED_HOSTS:-\}/,
  );
  assert.match(productionCompose, /^\s+SIRAGPT_MCP_ALLOW_HTTP:\s*["']?0["']?\s*$/m);
  for (const document of [reference, operations]) {
    assert.match(document, /MCP[\s\S]{0,800}HTTPS[\s\S]{0,500}production/i);
    assert.match(document, /\*\.[a-z0-9.-]+[\s\S]{0,500}public suffix/i);
    assert.match(document, /User\.settings\.mcpAllowedHosts[\s\S]{0,500}intersect/i);
    assert.match(document, /missing[\s\S]{0,300}deny-all[\s\S]{0,300}degraded/i);
  }
});

test('every I20 MCP security suite is registered in the canonical backend test script', () => {
  const command = backendPackage.scripts?.test || '';
  for (const file of MCP_TESTS) {
    assert.match(
      command,
      new RegExp(`(?:^|\\s)${file.replaceAll('.', '\\.')}(?:\\s|$)`),
      `${file} is not canonical`,
    );
  }
});

test('requested and verified organization contexts are threaded separately into MCP policy resolution', () => {
  const aiRoute = read('backend/src/routes/ai.js');
  const agenticRuntime = read('backend/src/services/agentic-chat-stream.js');
  const harnessRuntime = read('backend/src/services/agent-harness/run-agent-turn.js');

  assert.match(aiRoute, /const __requestedOrgIdForAi\s*=[\s\S]{0,300}resolveOrgId\(req\)/);
  assert.match(
    aiRoute,
    /toolContext:\s*\{[\s\S]{0,700}requestedOrganizationId:\s*__requestedOrgIdForAi[\s\S]{0,300}activeOrganizationId:\s*__orgIdForAi/,
  );
  assert.match(
    agenticRuntime,
    /attachHarness\(\{[\s\S]{0,600}requestedOrganizationId:\s*toolContext\.requestedOrganizationId\s*\|\|\s*null[\s\S]{0,200}activeOrganizationId:\s*toolContext\.activeOrganizationId\s*\|\|\s*null/,
  );
  assert.match(
    harnessRuntime,
    /loadUserMcpTools\(\{[\s\S]{0,250}requestedOrganizationId[\s\S]{0,100}activeOrganizationId/,
  );
});
