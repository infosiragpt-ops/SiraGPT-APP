'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const RATE_LIMIT_KEYS = Object.freeze([
  'RATE_LIMIT_SENSITIVE_POLICY',
  'RATE_LIMIT_REDIS_COMMAND_TIMEOUT_MS',
  'RATE_LIMIT_STORE_RETRY_AFTER_SECONDS',
  'RATE_LIMIT_BILLING_CHECKOUT_MAX',
  'RATE_LIMIT_BILLING_CHECKOUT_IP_MAX',
  'RATE_LIMIT_BILLING_VERIFY_MAX',
  'RATE_LIMIT_BILLING_VERIFY_IP_MAX',
  'RATE_LIMIT_BILLING_PLAN_CHANGE_MAX',
  'RATE_LIMIT_BILLING_PLAN_CHANGE_IP_MAX',
  'RATE_LIMIT_BILLING_WINDOW_MS',
  'RATE_LIMIT_BILLING_PLAN_WINDOW_MS',
  'RATE_LIMIT_BILLING_REFUND_MAX',
  'RATE_LIMIT_BILLING_REFUND_IP_MAX',
  'RATE_LIMIT_BILLING_REFUND_WINDOW_MS',
  'SIRAGPT_API_KEY_AUDIT_COUNTER_MAX',
]);
const PROXY_KEYS = Object.freeze([
  'TRUST_PROXY_HOPS',
  'TRUST_PROXY_CIDR',
]);
const SAML_KEYS = Object.freeze([
  'SAML_REQUEST_TTL_MS',
  'SAML_REQUEST_CACHE_MAX_ENTRIES',
  'SAML_REDIS_CONNECT_TIMEOUT_MS',
  'SAML_REDIS_COMMAND_TIMEOUT_MS',
  'SAML_REDIS_RETRY_BASE_MS',
  'SAML_REDIS_RETRY_MAX_MS',
  'SAML_REDIS_PREFIX',
  'SAML_RELAY_STATE_SECRET',
  'SAML_ACS_BODY_LIMIT_BYTES',
  'SAML_ACS_RATE_LIMIT_MAX',
  'SAML_ACS_RATE_LIMIT_WINDOW_MS',
]);
const AUTH_SECURITY_KEYS = Object.freeze([
  'SESSION_TOKEN_HASH_MODE',
  'SESSION_TOKEN_HASH_COMPAT_DRAINED',
  'SESSION_TOKEN_HASH_BACKFILL_BATCH_SIZE',
  'SESSION_TOKEN_HASH_BACKFILL_MAX_BATCHES',
  'AUTH_SECURITY_REDIS_MAX_MEMORY_RATIO',
  'AUTH_SECURITY_READY_RETRY_BASE_MS',
  'AUTH_SECURITY_READY_RETRY_MAX_MS',
  'OAUTH_STATE_TTL',
  'OAUTH_STATE_RETRY_AFTER_SECONDS',
  'OAUTH_STATE_CACHE_MAX_ENTRIES',
  'OAUTH_STATE_REDIS_CONNECT_TIMEOUT_MS',
  'OAUTH_STATE_REDIS_COMMAND_TIMEOUT_MS',
  'OAUTH_STATE_REDIS_PREFIX',
  'IMPERSONATION_TARGET_LIMIT',
  'IMPERSONATION_ADMIN_LIMIT',
  'IMPERSONATION_WINDOW_MS',
  'IMPERSONATION_MEMORY_MAX_KEYS',
  'IMPERSONATION_REDIS_CONNECT_TIMEOUT_MS',
  'IMPERSONATION_REDIS_COMMAND_TIMEOUT_MS',
  'IMPERSONATION_REDIS_PREFIX',
  'IMPERSONATION_STORE_RETRY_AFTER_SECONDS',
]);
const OAUTH_URL_KEYS = Object.freeze([
  'GOOGLE_AUTH_BASE_URL',
  'GOOGLE_AUTH_URI',
  'GOOGLE_REDIRECT_URI',
  'GOOGLE_REDIRECT_CALENDAR_DRIVE_URI',
  'GITHUB_OAUTH_REDIRECT_URI',
  'GITHUB_OAUTH_SUCCESS_REDIRECT',
  'SPOTIFY_REDIRECT_URI',
  'SPOTIFY_OAUTH_SUCCESS_REDIRECT',
  'SPOTIFY_OAUTH_FAILURE_REDIRECT',
  'OAUTH_POST_CALLBACK_ALLOWED_ORIGINS',
]);

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('environment templates and reference docs inventory sensitive limiter controls', () => {
  const rootExample = read('.env.example');
  const backendExample = read('backend/.env.example');
  const reference = read('docs/ENV_VARIABLES.md');
  const operations = read('docs/operations/ENVIRONMENT.md');

  for (const key of RATE_LIMIT_KEYS) {
    const assignment = new RegExp(`^${escapeRegex(key)}=`, 'm');
    assert.match(rootExample, assignment, `.env.example missing ${key}`);
    assert.match(backendExample, assignment, `backend/.env.example missing ${key}`);
    assert.ok(reference.includes(`\`${key}\``), `ENV_VARIABLES.md missing ${key}`);
    assert.ok(operations.includes(`\`${key}\``), `operations environment doc missing ${key}`);
  }
  for (const key of PROXY_KEYS) {
    const assignment = new RegExp(`^${escapeRegex(key)}=`, 'm');
    assert.match(rootExample, assignment, `.env.example missing ${key}`);
    assert.match(backendExample, assignment, `backend/.env.example missing ${key}`);
    assert.ok(reference.includes(`\`${key}\``), `ENV_VARIABLES.md missing ${key}`);
    assert.ok(operations.includes(`\`${key}\``), `operations environment doc missing ${key}`);
  }
  assert.match(reference, /CORS_ORIGINS[\s\S]*wildcard[\s\S]*production/i);
  assert.match(reference, /CSRF_DISABLED[\s\S]*production/i);
});

test('Compose passes fail-closed sensitive and billing limiter configuration', () => {
  const localCompose = read('docker-compose.yml');
  const productionCompose = read('docker-compose.prod.yml');

  for (const key of RATE_LIMIT_KEYS) {
    const mapping = new RegExp(`^\\s+${escapeRegex(key)}:`, 'm');
    assert.match(localCompose, mapping, `docker-compose.yml missing ${key}`);
    assert.match(productionCompose, mapping, `docker-compose.prod.yml missing ${key}`);
  }
  for (const key of SAML_KEYS) {
    const mapping = new RegExp(`^\\s+${escapeRegex(key)}:`, 'm');
    assert.match(localCompose, mapping, `docker-compose.yml missing ${key}`);
    assert.match(productionCompose, mapping, `docker-compose.prod.yml missing ${key}`);
  }

  assert.match(productionCompose, /^\s+RATE_LIMIT_STORE:\s*redis\s*$/m);
  assert.match(productionCompose, /^\s+RATE_LIMIT_SENSITIVE_POLICY:\s*distributed\s*$/m);
  assert.match(productionCompose, /^\s+TRUST_PROXY_HOPS:\s*["']?1["']?\s*$/m);
  assert.match(localCompose, /^\s+TRUST_PROXY_HOPS:\s*["']?\$\{TRUST_PROXY_HOPS:-0\}["']?\s*$/m);
  assert.doesNotMatch(localCompose, /^\s+TRUST_PROXY_HOPS:\s*["']?[1-9]\d*["']?\s*$/m);
  assert.match(
    localCompose,
    /^\s+CORS_ORIGINS:\s*["']?\$\{CORS_ORIGINS:-http:\/\/localhost:3000\}["']?\s*$/m,
  );
  assert.match(
    productionCompose,
    /^\s+CORS_ORIGINS:\s*["']?\$\{CORS_ORIGINS:-https:\/\/siragpt\.com,https:\/\/www\.siragpt\.com,https:\/\/office\.siragpt\.com\}["']?\s*$/m,
  );
  assert.doesNotMatch(productionCompose, /siragpt\.io/i);
  assert.match(productionCompose, /^\s+NODE_ENV:\s*production\s*$/m);
});

test('production CI smoke environments never pair credentialed CORS with a wildcard', () => {
  for (const workflow of [
    '.github/workflows/ci.yml',
    'siraGPT/.github/workflows/ci.yml',
  ]) {
    const source = read(workflow);
    assert.match(source, /^\s+NODE_ENV:\s*production\s*$/m, `${workflow} must use literal production`);
    assert.doesNotMatch(
      source,
      /^\s+CORS_ORIGINS:\s*["']?\*["']?\s*$/m,
      `${workflow} must use an exact smoke-test browser origin`,
    );
    assert.match(
      source,
      /^\s+CORS_ORIGINS:\s*["']?https:\/\/web\.ci\.example\.test["']?\s*$/m,
      `${workflow} must trust only its configured HTTPS frontend`,
    );
    assert.match(source, /^\s+FRONTEND_URL:\s*https:\/\/web\.ci\.example\.test\s*$/m);
    assert.match(source, /^\s+GOOGLE_AUTH_BASE_URL:\s*https:\/\/api\.ci\.example\.test\s*$/m);
    for (const key of [
      'GOOGLE_AUTH_URI',
      'GOOGLE_REDIRECT_URI',
      'GOOGLE_REDIRECT_CALENDAR_DRIVE_URI',
      'GITHUB_OAUTH_REDIRECT_URI',
      'GITHUB_OAUTH_SUCCESS_REDIRECT',
      'SPOTIFY_REDIRECT_URI',
      'SPOTIFY_OAUTH_SUCCESS_REDIRECT',
      'SPOTIFY_OAUTH_FAILURE_REDIRECT',
    ]) {
      assert.match(
        source,
        new RegExp(`^\\s+${key}:\\s*https://[^\\s]*\\.example\\.test(?:/[^\\s]*)?\\s*$`, 'm'),
        `${workflow} must provide a non-local HTTPS ${key}`,
      );
    }
    assert.match(source, /redis-cli CONFIG SET maxmemory 268435456/);
    assert.match(source, /redis-cli CONFIG SET maxmemory-policy noeviction/);
  }
});

test('environment docs require literal production and reject the prod alias', () => {
  const reference = read('docs/ENV_VARIABLES.md');
  const operations = read('docs/operations/ENVIRONMENT.md');
  for (const document of [reference, operations]) {
    assert.match(document, /NODE_ENV[\s\S]{0,200}literal [`"']?production/i);
    assert.match(document, /prod[`"']? alias[\s\S]{0,120}reject/i);
  }
});

test('environment templates and docs inventory the fail-closed SP-initiated SAML flow', () => {
  const rootExample = read('.env.example');
  const backendExample = read('backend/.env.example');
  const reference = read('docs/ENV_VARIABLES.md');
  const operations = read('docs/operations/ENVIRONMENT.md');

  for (const key of SAML_KEYS) {
    const assignment = new RegExp(`^${escapeRegex(key)}=`, 'm');
    assert.match(rootExample, assignment, `.env.example missing ${key}`);
    assert.match(backendExample, assignment, `backend/.env.example missing ${key}`);
    assert.ok(reference.includes(`\`${key}\``), `ENV_VARIABLES.md missing ${key}`);
    assert.ok(operations.includes(`\`${key}\``), `operations environment doc missing ${key}`);
  }

  for (const document of [reference, operations]) {
    assert.match(document, /SP-initiated[\s\S]{0,500}AuthnRequest/i);
    assert.match(document, /validateInResponseTo[\s\S]{0,100}[`"']?always/i);
    assert.match(document, /production[\s\S]{0,300}Redis[\s\S]{0,200}fail(?:s|ed)? closed/i);
    assert.match(document, /RelayState[\s\S]{0,200}organi[sz]ation[\s\S]{0,200}request/i);
    assert.match(document, /IdP[\s\S]{0,160}CORS[\s\S]{0,100}(?:not|required|none|without)/i);
    assert.match(document, /pre-auth[\s\S]{0,300}HttpOnly[\s\S]{0,200}SameSite=None/i);
    assert.match(document, /303[\s\S]{0,200}FRONTEND_URL[\s\S]{0,300}(?:without|no)[\s\S]{0,80}JWT/i);
    assert.match(document, /Redis[\s\S]{0,250}(?:backoff|circuit)[\s\S]{0,250}recover/i);
    assert.match(document, /ACS[\s\S]{0,300}(?:rate limit|limiter)[\s\S]{0,300}(?:before|pre-parser)/i);
  }
});

test('environment templates and docs inventory distributed OAuth and impersonation controls', () => {
  const rootExample = read('.env.example');
  const backendExample = read('backend/.env.example');
  const reference = read('docs/ENV_VARIABLES.md');
  const operations = read('docs/operations/ENVIRONMENT.md');

  for (const key of AUTH_SECURITY_KEYS) {
    const assignment = new RegExp(`^${escapeRegex(key)}=`, 'm');
    assert.match(rootExample, assignment, `.env.example missing ${key}`);
    assert.match(backendExample, assignment, `backend/.env.example missing ${key}`);
    assert.ok(reference.includes(`\`${key}\``), `ENV_VARIABLES.md missing ${key}`);
    assert.ok(operations.includes(`\`${key}\``), `operations environment doc missing ${key}`);
  }
});

test('Compose passes distributed OAuth and impersonation controls to backend replicas', () => {
  const localCompose = read('docker-compose.yml');
  const productionCompose = read('docker-compose.prod.yml');

  for (const key of AUTH_SECURITY_KEYS) {
    const mapping = new RegExp(`^\\s+${escapeRegex(key)}:`, 'm');
    assert.match(localCompose, mapping, `docker-compose.yml missing ${key}`);
    assert.match(productionCompose, mapping, `docker-compose.prod.yml missing ${key}`);
  }
  assert.match(localCompose, /^\s+REDIS_URL:\s*["']?redis:\/\/redis:6379["']?\s*$/m);
  assert.match(productionCompose, /^\s+REDIS_URL:\s*["']?redis:\/\/redis:6379["']?\s*$/m);
  assert.match(localCompose, /redis-server[^\n]*--maxmemory-policy\s+noeviction/);
  assert.match(productionCompose, /redis-server[^\n]*--maxmemory-policy\s+noeviction/);
  assert.doesNotMatch(productionCompose, /--maxmemory-policy\s+(?:allkeys|volatile)-/);
});

test('central OAuth URL controls are documented and passed to every backend replica', () => {
  const rootExample = read('.env.example');
  const backendExample = read('backend/.env.example');
  const reference = read('docs/ENV_VARIABLES.md');
  const operations = read('docs/operations/ENVIRONMENT.md');
  const localCompose = read('docker-compose.yml');
  const productionCompose = read('docker-compose.prod.yml');

  for (const key of OAUTH_URL_KEYS) {
    const assignment = new RegExp(`^${escapeRegex(key)}=`, 'm');
    const mapping = new RegExp(`^\\s+${escapeRegex(key)}:`, 'm');
    assert.match(rootExample, assignment, `.env.example missing ${key}`);
    assert.match(backendExample, assignment, `backend/.env.example missing ${key}`);
    assert.ok(reference.includes(`\`${key}\``), `ENV_VARIABLES.md missing ${key}`);
    assert.ok(operations.includes(`\`${key}\``), `operations environment doc missing ${key}`);
    assert.match(localCompose, mapping, `docker-compose.yml missing ${key}`);
    assert.match(productionCompose, mapping, `docker-compose.prod.yml missing ${key}`);
  }
});

test('production activates hashed sessions only after the compatibility rollout', () => {
  const productionCompose = read('docker-compose.prod.yml');
  const localCompose = read('docker-compose.yml');

  assert.match(productionCompose, /SESSION_TOKEN_HASH_MODE:\s+\$\{SESSION_TOKEN_HASH_MODE:-hash\}/);
  assert.match(localCompose, /SESSION_TOKEN_HASH_MODE:\s+"\$\{SESSION_TOKEN_HASH_MODE:-compat\}"/);
});

test('auth-security runbook documents migration, replay, outage, and limiter operations', () => {
  const runbook = read('docs/operations/AUTH_SECURITY.md');

  assert.match(runbook, /SHA-256[\s\S]{0,200}domain-separated/i);
  assert.match(runbook, /plaintext[\s\S]{0,600}atomic compare-and-swap/i);
  assert.match(runbook, /session-token:v1[\s\S]{0,200}appshots[\s\S]{0,300}never try[\s\S]{0,80}decode/i);
  assert.match(runbook, /backfill[\s\S]{0,500}readiness remains blocked/i);
  assert.match(runbook, /Google[\s\S]{0,300}Gmail[\s\S]{0,300}Spotify[\s\S]{0,300}GitHub/i);
  assert.match(runbook, /provider[\s\S]{0,200}user[\s\S]{0,200}redirect/i);
  assert.match(runbook, /one-time[\s\S]{0,200}TTL[\s\S]{0,300}replay/i);
  assert.match(runbook, /production[\s\S]{0,300}Redis[\s\S]{0,200}fail(?:s|ed)? closed/i);
  assert.match(runbook, /admin\s*\+\s*target[\s\S]{0,300}global admin/i);
  assert.match(runbook, /Retry-After[\s\S]{0,300}impersonate_denied/i);
  assert.match(runbook, /\/health\/ready[\s\S]{0,500}shutdown/i);
  assert.match(runbook, /compat[\s\S]{0,500}drain[\s\S]{0,500}hash/i);
  assert.match(runbook, /noeviction[\s\S]{0,300}memory[\s\S]{0,200}(?:ratio|capacity)/i);
  assert.match(runbook, /JTI[\s\S]{0,200}random[\s\S]{0,300}15 minutes/i);
  assert.match(runbook, /HTTPS[\s\S]{0,300}localhost[\s\S]{0,500}GitHub[\s\S]{0,300}Spotify/i);
  assert.match(runbook, /close fail(?:ure|ures)[\s\S]{0,300}non-?zero/i);
});
