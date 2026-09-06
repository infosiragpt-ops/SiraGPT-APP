'use strict';

// Synthetic test credentials only. No ambient application environment is copied.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const net = require('node:net');
const EMAIL = 'doc-browser-fixture@example.test';
const OWNER = 'doc-sandbox-browser-fixture';
const MODEL = 'claude-haiku-4-5';

function privateJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
}
function configure(source, evidence, database, postgresService) {
  assert.match(database, /^doc_sandbox_history_[a-z0-9_]+$/);
  assert.ok(['doc-sandbox-test-postgres', 'doc-sandbox-history-postgres'].includes(postgresService));
  assert.equal(fs.realpathSync(source), source);
  assert.match(source, /^\/home\/user\/deployments\/doc-sandbox-phase1-tests\/candidate-[A-Za-z0-9-]+$/);
  assert.match(evidence, /^\/tmp\/doc-sandbox-browser-[A-Za-z0-9-]+$/);
  fs.mkdirSync(evidence, { mode: 0o700 });
  for (const directory of [source, path.join(source, 'backend')]) {
    for (const file of ['.env', '.env.local', '.env.development', '.env.development.local', '.env.test', '.env.test.local']) {
      assert.equal(fs.existsSync(path.join(directory, file)), false, 'Test source must not load an environment file');
    }
  }
  const password = crypto.randomBytes(24).toString('base64url');
  const frontend = 'http://127.0.0.1:15162';
  const api = 'http://127.0.0.1:15161';
  const backendEnv = {
    NODE_ENV: 'test', CI: 'true', HOST: '0.0.0.0', PORT: '15161',
    DATABASE_URL: `postgresql://doc_fixture:fixture-only-isolated@${postgresService}:5432/${database}`,
    REDIS_URL: 'redis://doc-sandbox-test-redis:6379/12',
    JWT_SECRET: crypto.randomBytes(32).toString('hex'), SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    FRONTEND_URL: frontend, BASE_URL: api, BACKEND_PUBLIC_URL: api, CORS_ORIGINS: frontend,
    MAX_FILE_SIZE: '50', UPLOAD_DIR: '/tmp/doc-browser-uploads', DOC_SANDBOX_ENGINE: '',
    GOOGLE_CLIENT_ID: '123456789012-ci-smoke-oauth.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'ciSmokeOauthSecret0123456789abcdef',
    GOOGLE_AUTH_BASE_URL: api, GOOGLE_AUTH_URI: `${api}/api/auth/google/callback`,
    GOOGLE_REDIRECT_URI: `${api}/api/auth/gmail/callback`, GOOGLE_REDIRECT_CALENDAR_DRIVE_URI: `${api}/api/auth/google-services/callback`,
    GITHUB_OAUTH_REDIRECT_URI: `${api}/api/github/callback`, GITHUB_OAUTH_SUCCESS_REDIRECT: `${frontend}/settings`,
    SPOTIFY_REDIRECT_URI: `${api}/api/spotify/callback`, SPOTIFY_OAUTH_SUCCESS_REDIRECT: `${frontend}/agentes`, SPOTIFY_OAUTH_FAILURE_REDIRECT: `${frontend}/connections`,
    OPENAI_API_KEY: 'sk-ci-dummy-openai-key-not-used-in-smoke-test', ANTHROPIC_API_KEY: 'sk-ant-ci-dummy-key',
    OPENAI_BASE_URL: 'http://127.0.0.1:9/unavailable', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/unavailable',
    GROQ_API_KEY: 'gsk_ci_dummy_key', GEMINI_API_KEY: 'ci-dummy-gemini-key', OPENROUTER_API_KEY: 'sk-or-ci-dummy-key',
    ELEVENLABS_API_KEY: 'sk_ci_dummy_elevenlabs_key', STRIPE_SECRET_KEY: 'sk_test_ci_dummy_stripe_key', STRIPE_WEBHOOK_SECRET: 'whsec_ci_dummy',
    FAL_KEY: 'ci-dummy-fal-key', GOOGLE_API_KEY: 'ci-dummy-google-api-key', GOOGLE_SEARCH_ENGINE_ID: 'ci-dummy-cse-id',
    OTEL_ENABLED: 'false', SYSTEM_CRON_ENABLED: 'false', CODEX_PROACTIVE_ENABLED: '0',
    SIRAGPT_RAG_SKIP_UNTIL_SEND: 'true', SIRAGPT_OFFICE_IMAGE_VISION: 'false',
    SIRAGPT_FILES_OPENAI_MAX_RETRIES: '0',
    DOC_SANDBOX_E2E_PASSWORD: password,
  };
  fs.writeFileSync(path.join(evidence, 'backend.env'), Object.entries(backendEnv).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  privateJson(path.join(evidence, 'browser-env.json'), {
    PATH: process.env.PATH, HOME: '/home/user', NEXT_TELEMETRY_DISABLED: '1', CI: '1',
    PLAYWRIGHT_BASE_URL: frontend, NEXT_PUBLIC_API_URL: `${api}/api`,
    DOC_SANDBOX_E2E_ISOLATED: '1', DOC_SANDBOX_E2E_MODEL: MODEL,
    DOC_SANDBOX_E2E_EMAIL: EMAIL, DOC_SANDBOX_E2E_PASSWORD: password,
  });
  privateJson(path.join(evidence, 'scope.json'), { source, database, frontend, api, engineEnabled: false, network: 'doc-sandbox-phase1-test', paidCalls: 0 });
  console.log(JSON.stringify({ configured: true, evidence, database, frontend, api, engineEnabled: false }));
}
async function seed() {
  const url = new URL(process.env.DATABASE_URL);
  assert.ok(['doc-sandbox-test-postgres', 'doc-sandbox-history-postgres'].includes(url.hostname));
  assert.match(url.pathname, /^\/doc_sandbox_history_[a-z0-9_]+$/);
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.DOC_SANDBOX_ENGINE, '');
  assert.ok(process.env.DOC_SANDBOX_E2E_PASSWORD);
  const fromBackend = createRequire(path.join(process.cwd(), 'package.json'));
  const { PrismaClient } = fromBackend('@prisma/client');
  const bcrypt = fromBackend('bcryptjs');
  const db = new PrismaClient();
  try {
    const migrations = await db.$queryRawUnsafe('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL');
    assert.ok(migrations.some(row => row.migration_name === '20260905000000_doc_sandbox_core'), 'Apply the full historical migrations including F1 before seeding');
    assert.ok(migrations.length > 10, 'A doc-only fixture schema cannot substitute for application migrations');
    const [rawTables] = await db.$queryRawUnsafe("SELECT to_regclass('credits') IS NOT NULL AND to_regclass('credit_transactions') IS NOT NULL AS ready");
    assert.equal(rawTables.ready, true, 'Preserve the historical credit tables outside the Prisma datamodel when aligning the browser fixture');
    const existing = await db.user.findUnique({ where: { email: EMAIL }, select: { id: true } });
    assert.ok(!existing || existing.id === OWNER, 'Refusing to overwrite another test account');
    const password = await bcrypt.hash(process.env.DOC_SANDBOX_E2E_PASSWORD, 10);
    await db.user.upsert({ where: { id: OWNER }, create: {
      id: OWNER, name: 'Document browser fixture', email: EMAIL, password, plan: 'PRO',
      monthlyLimit: 1000000n, monthlyCallLimit: 100n, emailVerifiedAt: new Date(), locale: 'es',
    }, update: { password } });
    await db.aiModel.upsert({ where: { name: MODEL }, create: {
      name: MODEL, displayName: 'Sira Pro', provider: 'Anthropic', type: 'TEXT', isActive: true, tags: ['test'],
    }, update: { isActive: true } });
    console.log(JSON.stringify({ seeded: true, account: OWNER, migrations: migrations.length, paidCalls: 0 }));
  } finally { await db.$disconnect(); }
}
async function run(source, evidence) {
  const envFile = path.join(evidence, 'browser-env.json');
  const stat = fs.lstatSync(envFile);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0);
  const env = JSON.parse(fs.readFileSync(envFile, 'utf8'));
  const child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config=playwright.docs.config.ts',
    '--grep', '@no-provider-call', '--reporter=list', `--output=${path.join(evidence, 'browser')}`], { cwd: source, env, stdio: 'inherit' });
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
}
async function proxy(target) {
  assert.ok(['backend', 'frontend'].includes(target));
  const port = target === 'backend' ? 15161 : 15162;
  const { stdout } = await promisify(execFile)('docker', ['inspect', '--format',
    '{{(index .NetworkSettings.Networks "doc-sandbox-phase1-test").IPAddress}}', `doc-sandbox-browser-${target}`]);
  const address = stdout.trim();
  assert.equal(net.isIP(address), 4, 'The fixed browser container must exist on the internal test network');
  const server = net.createServer(client => {
    const upstream = net.connect(port, address);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.pipe(upstream); upstream.pipe(client);
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  console.log(JSON.stringify({ listening: true, target, port, interface: '127.0.0.1' }));
}
async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'configure') configure(...args);
  else if (mode === 'seed') await seed();
  else if (mode === 'run') await run(...args);
  else if (mode === 'proxy') await proxy(...args);
  else throw new Error('Use configure, seed, run or proxy');
}
main().catch(error => { console.error(JSON.stringify({ status: 'failed', code: error.code || error.name, message: 'Isolated browser fixture prerequisite or operation failed; inspect private evidence.' })); process.exitCode = 1; });
