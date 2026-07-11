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
      /^\s+CORS_ORIGINS:\s*["']?http:\/\/localhost:3000["']?\s*$/m,
      `${workflow} must trust only its configured local frontend`,
    );
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
