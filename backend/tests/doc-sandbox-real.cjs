'use strict';

/**
 * Real provider + real PostgreSQL + real private S3 + real runsc validation.
 * Default reduced SMOKE suite; explicit --suite=complex loads the full synthetic
 * corpus. Neither automatically satisfies §10 or phase-1 acceptance gates.
 * Not a browser/API E2E test.
 * No mocks, skip, automatic model fallback or
 * production writes. The durable budget schema is intentionally NEVER dropped.
 *
 * Preflight (no paid request):
 * node tests/doc-sandbox-real.cjs --preflight --campaign=phase1-a --authorize-usd=5 --out=/private/path/evidence
 * Execution additionally requires --execute-real instead of --preflight and a
 * private DOC_SANDBOX_REAL_PROVIDER_LIMIT_PROOF_FILE. Never put a key in args.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Client: PgClient } = require('pg');
const { PrismaClient, Prisma } = require('@prisma/client');
const { HeadBucketCommand } = require('@aws-sdk/client-s3');
const { loadDocumentSandboxConfig } = require('../dist/doc-sandbox/config');
const { PrivateDocumentStorage, decodeStorageKey, createPrivateDocumentS3Client } = require('../dist/doc-sandbox/storage/private-storage');
const { IndependentDocumentValidator } = require('../dist/doc-sandbox/validation');
const { DocSandboxRepository } = require('../dist/doc-sandbox/queue/repository');
const { DocumentSandboxProcessor } = require('../dist/doc-sandbox/queue/processor');
const { AnthropicSandboxEngine } = require('../dist/doc-sandbox/engine/anthropic-engine');
const { AnthropicDocumentProviderClient } = require('../dist/doc-sandbox/engine/provider-client');
const { EDITOR_PROMPT_VERSION } = require('../dist/doc-sandbox/agent/prompt');
const { hasCompleteValidation } = require('../dist/doc-sandbox/types/contracts');
const { makeFixtures, FIXTURE_VERSION, digest } = require('./doc-sandbox-real.fixtures.cjs');
const { loadComplexCases } = require('./fixtures/complex-cases.cjs');
const { VERSION: COMPLEX_FIXTURE_VERSION } = require('./fixtures/build-docs.cjs');
const { verifyComplexExpected } = require('./fixtures/complex-oracle.cjs');

const SCHEMA = 'doc_sandbox_real_phase1';
const OWNER = 'doc-real-phase1-authorized-budget';
const AUTHORIZATION = 'phase1-user-authorized-five-usd';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const ISOLATED_POSTGRES = new Set([...LOOPBACK, 'doc-sandbox-test-postgres']);
const ISOLATED_STORAGE = new Set([...LOOPBACK, 'doc-sandbox-test-minio']);
const ISOLATED_REDIS = new Set([...LOOPBACK, 'doc-sandbox-test-redis']);
const roundUp = (value) => (Math.ceil(value * 100_000_000) / 100_000_000).toFixed(8);
const safeCode = (error) => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code) ? error.code : 'DOC_REAL_FAILED';
function requireEnv(name, env = process.env) {
  const value = env[name]?.trim();
  if (!value) throw Object.assign(new Error('Required real prerequisite is missing.'), { code: 'DOC_REAL_ENV_MISSING', setting: name });
  return value;
}

/** Infrastructure-only preflight: no Anthropic credentials or guessed provider configuration. */
function loadPreflightConfig(env = process.env) {
  const validatorImage = requireEnv('DOC_SANDBOX_VALIDATOR_IMAGE', env);
  assert.match(validatorImage, /^(?:[a-zA-Z0-9][a-zA-Z0-9./:_-]*@)?sha256:[a-f0-9]{64}$/);
  const validatorStagingRoot = requireEnv('DOC_SANDBOX_VALIDATION_STAGING_ROOT', env);
  assert.ok(path.isAbsolute(validatorStagingRoot) && path.normalize(validatorStagingRoot) === validatorStagingRoot
    && !validatorStagingRoot.endsWith('/') && validatorStagingRoot === env.DOC_SANDBOX_VALIDATION_STAGING_ROOT
    && !/[\x00-\x1f\x7f,]/.test(validatorStagingRoot), 'A valid shared staging root is required');
  const keyId = env.DOC_SANDBOX_ENCRYPTION_KEY_ID?.trim() || 'v1';
  assert.match(keyId, /^[A-Za-z0-9_-]{1,40}$/);
  const previous = JSON.parse(env.DOC_SANDBOX_PREVIOUS_KEYS_JSON || '{}');
  assert.ok(previous && typeof previous === 'object' && !Array.isArray(previous));
  const previousKeys = {};
  for (const [id, value] of Object.entries(previous)) {
    assert.match(id, /^[A-Za-z0-9_-]{1,40}$/); assert.notEqual(id, keyId);
    assert.equal(typeof value, 'string'); previousKeys[id] = decodeStorageKey(value);
  }
  return {
    bucket: env.R2_BUCKET_NAME?.trim() || requireEnv('R2_BUCKET', env),
    r2AccessKeyId: requireEnv('R2_ACCESS_KEY_ID', env), r2SecretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY', env),
    storageKey: decodeStorageKey(requireEnv('DOC_SANDBOX_ENCRYPTION_KEY', env)), keyId, previousKeys,
    validatorImage, validatorStagingRoot, maxStorageBytes: 100 * 1024 * 1024,
  };
}
function loadRunnerConfig(mode, env = process.env) {
  if (mode === 'preflight') return loadPreflightConfig(env);
  assert.equal(mode, 'execute-real');
  const config = loadDocumentSandboxConfig(env);
  assert.ok(config, 'DOC_SANDBOX_ENGINE must explicitly enable Anthropic for paid execution');
  assert.ok(ISOLATED_REDIS.has(new URL(config.redisUrl).hostname), 'Redis configuration must point at the isolated test host');
  return { ...config, maxStorageBytes: config.engine.maxOutputBytes };
}
function options(args) {
  const result = {};
  for (const arg of args) {
    const match = /^--(campaign|authorize-usd|out|suite|fixtures-dir)=(.+)$/.exec(arg);
    if (match) { assert.equal(result[match[1]], undefined, 'Duplicate CLI option'); result[match[1]] = match[2]; }
    else if (arg === '--execute-real' || arg === '--preflight') { assert.equal(result.mode, undefined, 'Choose exactly one mode'); result.mode = arg.slice(2); }
    else throw new Error('Unsupported argument; keys must be configured only as environment secrets');
  }
  assert.ok(result.mode, 'Explicit --preflight or --execute-real is mandatory');
  assert.match(result.campaign || '', /^[a-z0-9][a-z0-9_-]{1,39}$/);
  const authorizationUsd = Number(result['authorize-usd']);
  assert.ok(Number.isFinite(authorizationUsd) && authorizationUsd > 0.5 && authorizationUsd <= 5,
    'Explicit --authorize-usd must be >0.50 and <=5 TOTAL, not per job');
  assert.ok(result.out && path.isAbsolute(result.out), '--out must be an absolute private evidence directory');
  const suite = result.suite || 'smoke';
  assert.ok(['smoke', 'complex'].includes(suite), '--suite must be smoke or complex');
  if (suite === 'complex') assert.ok(result['fixtures-dir'] && path.isAbsolute(result['fixtures-dir'])
    && path.normalize(result['fixtures-dir']) === result['fixtures-dir'] && result['fixtures-dir'] !== path.parse(result['fixtures-dir']).root,
  '--suite=complex requires a normalized absolute non-root --fixtures-dir');
  else assert.equal(result['fixtures-dir'], undefined, '--fixtures-dir is only accepted with --suite=complex');
  return { ...result, suite, authorizationUsd, marginUsd: Math.max(0.5, authorizationUsd * 0.15) };
}
async function loadSuite(opt) {
  return opt.suite === 'complex'
    ? { fixtures: await loadComplexCases(opt['fixtures-dir']), fixtureVersion: COMPLEX_FIXTURE_VERSION }
    : { fixtures: await makeFixtures(), fixtureVersion: FIXTURE_VERSION };
}
async function privateJson(filename, value) {
  const handle = await fs.open(filename, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
}
async function proofOfProviderCap(authorizationUsd) {
  const filename = requireEnv('DOC_SANDBOX_REAL_PROVIDER_LIMIT_PROOF_FILE');
  assert.ok(path.isAbsolute(filename), 'The provider-cap evidence path must be absolute');
  const stat = await fs.lstat(filename);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.size < 20_000,
    'Provider cap evidence must be a private regular file, not a key or symlink');
  const proof = JSON.parse(await fs.readFile(filename, 'utf8'));
  assert.equal(proof.provider, 'anthropic'); assert.equal(proof.providerEnforced, true);
  assert.ok(Number.isFinite(proof.hardLimitUsd) && proof.hardLimitUsd > 0 && proof.hardLimitUsd <= authorizationUsd);
  assert.ok(Number.isFinite(proof.remainingUsd) && proof.remainingUsd > 0 && proof.remainingUsd <= proof.hardLimitUsd);
  const age = Date.now() - Date.parse(proof.verifiedAt);
  assert.ok(Number.isFinite(age) && age >= 0 && age < 24 * 3600_000, 'Provider hard-cap evidence must be verified within 24 hours');
  assert.match(proof.reference || '', /^[A-Za-z0-9_.:/-]{1,200}$/);
  // This is explicit operator evidence, not an invented programmatic provider
  // billing API verification. Without it the runner refuses paid requests.
  return { type: 'operator-verified-provider-hard-cap', reference: proof.reference, verifiedAt: proof.verifiedAt,
    hardLimitUsd: proof.hardLimitUsd, remainingUsd: proof.remainingUsd };
}

async function initializeLedger(lock, authorizationUsd, marginUsd) {
  await lock.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await lock.query(`SET search_path TO ${SCHEMA}`);
  const acquired = await lock.query('SELECT pg_try_advisory_lock($1, $2) AS acquired', [1768191, 15001]);
  assert.equal(acquired.rows[0].acquired, true, 'Another real campaign holds the aggregate budget lock');
  const existing = await lock.query("SELECT to_regclass('doc_jobs') AS name");
  if (!existing.rows[0].name) {
    // Dedicated test namespace only. Full application migrations have their own gate.
    await lock.query('BEGIN');
    try {
      await lock.query(`CREATE TABLE users(id TEXT PRIMARY KEY,"deletedAt" TIMESTAMPTZ,plan TEXT NOT NULL DEFAULT 'PRO',"isSuperAdmin" BOOLEAN NOT NULL DEFAULT false,"apiUsage" BIGINT NOT NULL DEFAULT 0,"monthlyLimit" BIGINT NOT NULL DEFAULT 10000000)`);
      await lock.query('CREATE TABLE api_usage(id TEXT PRIMARY KEY,"userId" TEXT REFERENCES users(id) ON DELETE CASCADE,model TEXT,tokens BIGINT,cost DOUBLE PRECISION,timestamp TIMESTAMPTZ)');
      const sql = await fs.readFile(path.join(__dirname, '../prisma/migrations/20260905000000_doc_sandbox_core/migration.sql'), 'utf8');
      await lock.query(sql);
      await lock.query(`CREATE TABLE doc_real_authorization(id TEXT PRIMARY KEY, authorized_usd NUMERIC(18,8) NOT NULL,
        margin_usd NUMERIC(18,8) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await lock.query('COMMIT');
    } catch (error) { await lock.query('ROLLBACK'); throw error; }
  }
  await lock.query('INSERT INTO users(id) VALUES($1) ON CONFLICT DO NOTHING', [OWNER]);
  await lock.query('INSERT INTO doc_real_authorization(id,authorized_usd,margin_usd) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [AUTHORIZATION, roundUp(authorizationUsd), roundUp(marginUsd)]);
  const row = (await lock.query('SELECT * FROM doc_real_authorization WHERE id=$1', [AUTHORIZATION])).rows[0];
  assert.equal(Number(row.authorized_usd), authorizationUsd, 'An existing authorization cannot be increased/reset by another campaign');
  assert.equal(Number(row.margin_usd), marginUsd);
}
async function campaignBalance(db) {
  const rows = await db.$queryRaw(Prisma.sql`SELECT id,status,usage,cost_usd,cost_reservations FROM doc_jobs WHERE user_id=${OWNER}`);
  let settledUsd = 0; let reservedUsd = 0; let unknown = false;
  for (const row of rows) {
    settledUsd += Number(row.cost_usd);
    if (row.usage?.costUsd === null) unknown = true;
    for (const reservation of row.cost_reservations) {
      if (reservation.actualUsd === null) { reservedUsd += Number(reservation.reservedUsd); unknown = true; }
    }
  }
  return { settledUsd, reservedUsd, committedUsd: settledUsd + reservedUsd, unknown, jobs: rows.length,
    costBasis: 'configured-tariff-estimate-not-provider-invoice' };
}

function verifyExpected(smoke, output, outputInventory, plan, report) {
  const original = smoke.inputs[0];
  assert.equal(output.name, original.name, 'Original filename must be retained');
  assert.equal(report.originalSha256, original.sha256);
  assert.equal(report.outputSha256, digest(output.data));
  assert.ok(hasCompleteValidation(report, original.format), 'Every independent required validation level must pass');
  assert.equal(plan.edits.length, smoke.expected.edits, 'Frozen plan must implement the requested operations, not a no-op substitute');
  assert.deepEqual(plan.notPossible, [], 'Smoke case cannot claim success by declining a supported synthetic operation');
  const text = outputInventory.units.map((unit) => unit.text);
  for (const value of smoke.expected.present || []) assert.ok(text.includes(value), `Expected synthetic content missing in ${smoke.id}`);
  for (const value of smoke.expected.absent || []) assert.ok(!text.includes(value), `Old synthetic content remains in ${smoke.id}`);
  if (smoke.expected.changed) assert.notEqual(digest(output.data), original.sha256);
  else assert.ok(output.data.equals(original.data), 'No-op must be byte-for-byte identical');
  if (smoke.expected.pages) {
    assert.equal(outputInventory.pages, smoke.expected.pages);
    for (const [index, value] of smoke.expected.pageText.entries()) assert.ok(text[index]?.includes(value), 'PDF page content/order changed');
  }
}

async function main() {
  const opt = options(process.argv.slice(2));
  // Verify every complex original's manifest/hash before touching infrastructure,
  // and never regenerate a replacement under the same campaign identity.
  const { fixtures, fixtureVersion } = await loadSuite(opt);
  const databaseUrl = new URL(requireEnv('DOC_SANDBOX_REAL_DATABASE_URL'));
  assert.ok(ISOLATED_POSTGRES.has(databaseUrl.hostname), 'Real campaigns require isolated loopback or exact doc-sandbox-test-postgres host');
  assert.match(databaseUrl.pathname, /doc[_-]sandbox|doc[_-]phase1/i, 'Use a dedicated document-test database, never the production database');
  databaseUrl.searchParams.set('schema', SCHEMA); databaseUrl.searchParams.set('connection_limit', '10');
  const config = loadRunnerConfig(opt.mode);
  const endpoint = new URL(requireEnv('R2_ENDPOINT'));
  assert.ok(ISOLATED_STORAGE.has(endpoint.hostname), 'The real campaign requires isolated loopback or exact doc-sandbox-test-minio host');
  assert.match(config.bucket, /^doc-sandbox-phase1-real(?:-[a-z0-9-]+)?$/);
  const providerCap = opt.mode === 'execute-real' ? await proofOfProviderCap(opt.authorizationUsd) : null;
  await fs.mkdir(opt.out, { recursive: true, mode: 0o700 });
  assert.equal((await fs.stat(opt.out)).mode & 0o077, 0, 'Evidence directory must be private (0700)');
  const evidence = await fs.mkdtemp(path.join(opt.out, `${opt.campaign}-`));
  const controller = new AbortController(); const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const lockUrl = new URL(databaseUrl); lockUrl.searchParams.delete('schema'); lockUrl.searchParams.delete('connection_limit');
  const lock = new PgClient({ connectionString: lockUrl.toString(), connectionTimeoutMillis: 10_000, query_timeout: 10_000, statement_timeout: 10_000 });
  lock.on('error', cancel);
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl.toString() } } });
  const s3 = createPrivateDocumentS3Client({ region: 'auto', endpoint: endpoint.toString(), forcePathStyle: true,
    credentials: { accessKeyId: config.r2AccessKeyId, secretAccessKey: config.r2SecretAccessKey } });
  const storage = new PrivateDocumentStorage(s3, { bucket: config.bucket, key: config.storageKey, keyId: config.keyId,
    previousKeys: config.previousKeys, maxBytes: config.maxStorageBytes });
  const validator = new IndependentDocumentValidator({ image: config.validatorImage, runtime: 'runsc', stagingRoot: config.validatorStagingRoot });
  const repository = new DocSandboxRepository(db);
  let connected = false; let failed = false;
  const results = [];
  try {
    // Inspection alone does not prove Writer/Calc/Impress can open and render.
    // Both CLI modes require the real pinned runsc tool preflight before any
    // ledger mutation or provider construction; rejection reaches the fail-closed
    // campaign catch and no paid engine can be reached.
    await validator.preflight(controller.signal);
    await lock.connect(); connected = true;
    await initializeLedger(lock, opt.authorizationUsd, opt.marginUsd);
    await s3.send(new HeadBucketCommand({ Bucket: config.bucket }), { abortSignal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
    const initialBalance = await campaignBalance(db);
    assert.equal(initialBalance.unknown, false, 'Unknown prior billing requires reconciliation before another paid request');
    // Exercise every input's real parser/runsc boundary before spending anything.
    for (const smoke of fixtures) {
      const inputs = smoke.inputs.map((input, index) => ({ ...input, id: `${smoke.id}-input-${index}` }));
      await validator.inspect(inputs, controller.signal);
    }
    await privateJson(path.join(evidence, 'preflight.json'), { kind: `synthetic-${opt.suite}-infrastructure-preflight`, suite: opt.suite, syntheticOnly: true,
      specificationGoldensSatisfied: false, phase1GatesSatisfied: false,
      fixtureVersion, validatorImage: config.validatorImage,
      authorizationUsd: opt.authorizationUsd, marginUsd: opt.marginUsd, initialBalance, providerCap,
      cases: fixtures.map((smoke) => ({ id: smoke.id, inputs: smoke.inputs.map(({ name, sha256, format }) => ({ name, sha256, format })) })) });
    if (opt.mode === 'preflight') {
      return { status: `${opt.suite}-preflight-passed`, paidRequests: 0, specificationGoldensSatisfied: false, phase1GatesSatisfied: false, evidence };
    }
    const provider = new AnthropicDocumentProviderClient(config.apiKey);
    const providerSpendable = providerCap.remainingUsd - opt.marginUsd;
    assert.ok(providerSpendable > 0, 'Provider remaining limit is below the required safety margin');
    const processor = new DocumentSandboxProcessor({ repository, storage, validator,
      engineFactory: (persistence) => new AnthropicSandboxEngine(provider, config.engine, { ...persistence,
        reserve: async (session, reservation) => {
          controller.signal.throwIfAborted(); await lock.query('SELECT 1');
          const balance = await campaignBalance(db);
          assert.equal(balance.unknown, false, 'Unknown billing stops the entire campaign');
          assert.ok(balance.committedUsd + reservation.usd <= opt.authorizationUsd - opt.marginUsd,
            'Aggregate authorization exhausted; no further provider call');
          assert.ok(balance.committedUsd - initialBalance.committedUsd + reservation.usd <= providerSpendable,
            'Provider remaining spending headroom exhausted');
          await persistence.reserve(session, reservation);
        } }),
      onNotice: ({ code }) => console.log(JSON.stringify({ notice: code })),
    }, { maxTurns: config.maxTurns, maxTokens: config.maxTokens, timeoutMs: config.timeoutMs });
    for (const [index, smoke] of fixtures.entries()) {
      controller.signal.throwIfAborted();
      const balance = await campaignBalance(db); assert.equal(balance.unknown, false, 'Uncertain prior bill stops all smoke cases');
      const jobId = `real-${digest(Buffer.from(`${opt.campaign}:${smoke.id}`)).slice(0, 32)}`;
      const scope = { userId: OWNER, jobId };
      const payloadHash = digest(Buffer.from(JSON.stringify({ fixtureVersion, instructions: smoke.instructions,
        inputs: smoke.inputs.map(({ name, sha256 }) => ({ name, sha256 })) })));
      const previous = await db.$queryRaw(Prisma.sql`SELECT id,payload_hash FROM doc_jobs WHERE id=${jobId}`);
      let job;
      if (previous.length) {
        job = await repository.getInternal(jobId);
        assert.equal(job.userId, OWNER);
        assert.equal(previous[0].payload_hash, payloadHash, 'Existing job belongs to different fixture bytes/instructions; never relabel or replay it');
        // Never silently retry old, cancelled or uncertain provider work.
        assert.equal(job.status, 'done', 'Existing incomplete campaign job requires manual reconciliation; use no new paid attempt');
      } else {
        const spendable = Math.min(opt.authorizationUsd - opt.marginUsd - balance.committedUsd,
          providerSpendable - (balance.committedUsd - initialBalance.committedUsd));
        const jobBudget = Math.min(config.maxCostUsd, Math.floor(spendable / (fixtures.length - index) * 100_000_000) / 100_000_000);
        assert.ok(jobBudget >= config.engine.models.mechanical.reservationUsdPerTurn * 2,
          'Insufficient allowance for separate plan and edit calls; do not partially spend a doomed case');
        const inputs = smoke.inputs.map((input, inputIndex) => ({ ...input, id: `${jobId}-input-${inputIndex}` }));
        const prepared = inputs.map((input) => ({ input, object: storage.prepare(scope, input.data) }));
        const instructions = Buffer.from(smoke.instructions, 'utf8'); const instructionObject = storage.prepare(scope, instructions);
        const accepted = await repository.createJob({ id: jobId, userId: OWNER, idempotencyKey: `${opt.campaign}:${smoke.id}`,
          requestedModel: config.engine.models.mechanical.id, maxTokens: config.maxTokens,
          payloadHash,
          instructionsKey: instructionObject.key, inputs: prepared.map(({ input, object }) => ({ id: input.id, kind: 'input',
            storageKey: object.key, filename: input.name, mime: input.mime, size: object.size, sha256: object.sha256 })),
          modelTier: 'mechanical', promptVersion: EDITOR_PROMPT_VERSION, expiresAt: new Date(Date.now() + 30 * 86400_000),
          maxCostUsd: roundUp(jobBudget), ready: false });
        assert.equal(accepted.created, true);
        for (const { input, object } of prepared) await storage.putPrepared(scope, object, input.data, controller.signal);
        await storage.putPrepared(scope, instructionObject, instructions, controller.signal);
        await repository.markInputsReadyOwned(jobId, OWNER);
        await processor.process(jobId, controller.signal);
        job = await repository.getInternal(jobId);
      }
      const after = await campaignBalance(db);
      const caseResult = { id: smoke.id, jobId, status: job.status, attempts: job.attempts,
        suite: opt.suite, fixtureVersion, outcome: job.outcome,
        modelId: config.engine.models.mechanical.id, priceVersion: config.engine.models.mechanical.prices.version,
        usage: job.usage, campaignBalance: after, verification: 'not-completed', errorCode: job.errorCode,
        syntheticOnly: true, specificationGoldensSatisfied: false, phase1GatesSatisfied: false, realProcessor: true, browserE2e: false };
      results.push(caseResult);
      assert.equal(after.unknown, false, 'Unknown provider cost: stop, retain reservation and do not run the next smoke');
      assert.equal(job.status, 'done', 'A failed/requeued real smoke fails the campaign; no automatic extra attempts');
      const records = await repository.artifactsOwned(jobId, OWNER);
      for (const kind of ['output', 'edit_plan', 'agent_result', 'recipe', 'validation_report', 'text_diff'])
        assert.ok(records.some((record) => record.kind === kind), `Missing real ${kind} artifact`);
      const selected = records.filter((record) => record.kind === 'output'); assert.equal(selected.length, 1);
      const outputRecord = selected[0];
      const output = { name: outputRecord.filename, data: await storage.get(scope, outputRecord.storageKey, outputRecord.sha256, controller.signal) };
      const plan = JSON.parse((await storage.get(scope, job.editPlanKey, job.editPlanHash, controller.signal)).toString('utf8'));
      const report = JSON.parse((await storage.get(scope, job.validationReportKey, undefined, controller.signal)).toString('utf8'));
      // Reload the immutable original recorded for this run, not a regenerated substitute.
      const originalRecords = (await repository.artifactsInternal(jobId)).filter((record) => record.kind === 'input');
      assert.equal(originalRecords.length, smoke.inputs.length, 'Every original input must be retained');
      const actualInputs = await Promise.all(job.inputKeys.map(async (key, index) => {
        const record = originalRecords.find((entry) => entry.storageKey === key); assert.ok(record);
        const fixture = smoke.inputs[index]; assert.ok(fixture);
        assert.equal(record.filename, fixture.name); assert.equal(record.sha256, fixture.sha256);
        return { id: record.id, name: record.filename, format: fixture.format, mime: record.mime, sha256: record.sha256,
          data: await storage.get(scope, record.storageKey, record.sha256, controller.signal) };
      }));
      const original = actualInputs[0];
      caseResult.originals = actualInputs.map(({ name, sha256 }) => ({ name, sha256 }));
      const format = original.format;
      const inventory = (await validator.inspect([{ id: 'actual-output', name: output.name, format,
        mime: outputRecord.mime, data: output.data, sha256: digest(output.data) }], controller.signal))[0];
      if (opt.suite === 'complex') {
        const originalInventories = await validator.inspect(actualInputs, controller.signal);
        const agentRecord = records.find((record) => record.kind === 'agent_result');
        const agentResult = JSON.parse((await storage.get(scope, agentRecord.storageKey, agentRecord.sha256, controller.signal)).toString('utf8'));
        caseResult.oracle = verifyComplexExpected({ ...smoke, inputs: actualInputs }, output, originalInventories, inventory, plan, report, job, agentResult);
      } else verifyExpected({ ...smoke, inputs: actualInputs }, output, inventory, plan, report);
      const caseDirectory = path.join(evidence, smoke.id); await fs.mkdir(caseDirectory, { mode: 0o700 });
      const hashes = [];
      for (const record of new Map([...originalRecords, ...records].map((record) => [record.id, record])).values()) {
        const data = await storage.get(scope, record.storageKey, record.sha256, controller.signal);
        const name = `${record.kind}-${record.id}.${record.filename.split('.').pop()}`;
        await fs.writeFile(path.join(caseDirectory, name), data, { flag: 'wx', mode: 0o600 });
        hashes.push({ kind: record.kind, sha256: digest(data), bytes: data.length, localName: name });
      }
      caseResult.verification = `passed-independent-levels-and-explicit-${opt.suite}-assertions`;
      caseResult.hashes = hashes; caseResult.levels = report.levels;
      await privateJson(path.join(caseDirectory, 'result.json'), caseResult);
      console.log(JSON.stringify({ case: smoke.id, status: 'passed', estimatedAggregateUsd: after.committedUsd }));
    }
    return { status: `real-${opt.suite}-integration-passed`, cases: results.length, syntheticOnly: true,
      specificationGoldensSatisfied: false, phase1GatesSatisfied: false, browserE2e: false, evidence };
  } catch (error) {
    failed = true;
    // Provider/SDK/DB messages may contain secrets or document text: never log them.
    await privateJson(path.join(evidence, 'failure.json'), { code: safeCode(error), results,
      explanation: error instanceof assert.AssertionError ? String(error.message).slice(0, 300) : 'See the private durable job state; raw error bodies were not exported.' });
    throw Object.assign(new Error('The real document campaign failed; inspect private evidence and durable ledger.'), { code: safeCode(error), evidence });
  } finally {
    try {
      await privateJson(path.join(evidence, 'summary.json'), { mode: opt.mode, suite: opt.suite, fixtureVersion,
        passed: !failed && (opt.mode === 'preflight' || (results.length === fixtures.length && results.every((result) => result.oracle || opt.suite === 'smoke'))),
        syntheticOnly: true, specificationGoldensSatisfied: false, phase1GatesSatisfied: false,
        finalUserSamplesVerified: false, authorizationUsd: opt.authorizationUsd, marginUsd: opt.marginUsd,
        providerCap, schema: SCHEMA, results, budget: connected ? await campaignBalance(db).catch(() => ({ unknown: true })) : { unknown: true },
        ledgerRetained: true, remoteContainersDeleted: false });
    } finally {
      process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
      s3.destroy();
      await Promise.allSettled([db.$disconnect(), ...(connected ? [lock.end()] : [])]);
    }
  }
}

if (require.main === module) main().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(JSON.stringify({ status: 'failed', code: safeCode(error),
  evidence: error.evidence || null, setting: error.setting || null,
  message: 'Required real prerequisites or assertions failed; no skip/fallback. Raw details are not logged.' })); process.exitCode = 1; });
module.exports = { options, loadSuite, loadPreflightConfig, loadRunnerConfig, verifyExpected, proofOfProviderCap, campaignBalance, main };
