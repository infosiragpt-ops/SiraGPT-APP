import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Router } from 'express';
import { createDocumentModule, type DocumentModule } from '../src/modules/doc-sandbox';
const metrics = require('../src/utils/metrics');

// Real module/validator/filesystem, no successful substitute for Docker, Redis,
// PostgreSQL, S3 or a provider. Unsafe local staging must reject before any of
// those dependencies is contacted. No server or customer document is involved.
async function fixture(run: (documentModule: DocumentModule) => Promise<void>, missing = false): Promise<void> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'doc-module-preflight-')));
  await chmod(directory, 0o755);
  const model = { prices: { version: 'fixture-prices', inputPerMillionUsd: 1, outputPerMillionUsd: 2,
    cacheReadPerMillionUsd: 0.1, cacheWritePerMillionUsd: 1.25, executionPerHourUsd: 0, minimumExecutionSeconds: 0 },
    maxOutputTokensPerTurn: 1024, reservationUsdPerTurn: 0.05 };
  const config: NodeJS.ProcessEnv = {
    DOC_SANDBOX_ENGINE: 'anthropic',
    DOC_SANDBOX_MODELS_JSON: JSON.stringify({ mechanical: { ...model, id: 'fixture-mechanical' }, academic: { ...model, id: 'fixture-academic' } }),
    DOC_SANDBOX_SKILL_VERSIONS_JSON: JSON.stringify({ docx: 'fixture-v1', xlsx: 'fixture-v1', pptx: 'fixture-v1', pdf: 'fixture-v1' }),
    DOC_SANDBOX_VALIDATOR_IMAGE: `sha256:${'a'.repeat(64)}`,
    DOC_SANDBOX_VALIDATION_STAGING_ROOT: missing ? path.join(directory, 'missing') : directory,
    DOC_SANDBOX_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    DOC_SANDBOX_PREVIOUS_KEYS_JSON: '{}', DOC_SANDBOX_MAX_COST_USD: '0.25',
    REDIS_URL: 'redis://127.0.0.1:1', ANTHROPIC_API_KEY: 'synthetic-no-provider-key',
    R2_BUCKET_NAME: 'synthetic-test-bucket', R2_ACCOUNT_ID: 'synthetic-test-account',
    R2_ACCESS_KEY_ID: 'synthetic-test-access', R2_SECRET_ACCESS_KEY: 'synthetic-test-secret',
    R2_ENDPOINT: 'http://127.0.0.1:1',
  };
  const original = new Map(Object.keys(config).map(key => [key, process.env[key]]));
  const prisma = new PrismaClient({ datasources: { db: {
    url: 'postgresql://synthetic:synthetic@127.0.0.1:1/doc_sandbox_unit?connect_timeout=1',
  } } });
  let documentModule: DocumentModule | undefined;
  let redisAttempts = 0;
  try {
    Object.assign(process.env, config);
    documentModule = createDocumentModule({ prisma, authenticate: Router(), admissionPolicy: Router(), metrics,
      createRedisConnection: () => { redisAttempts++; return assert.fail('Unsafe staging reached Redis construction'); },
      runtimeOptions: {}, isModelPlanEligible: () => assert.fail('Preflight reached model admission'),
      notice: () => assert.fail('Preflight without allocated workers must unwind without cleanup warnings'),
    });
    await run(documentModule);
    assert.equal(redisAttempts, 0);
  } finally {
    try { await documentModule?.close(); }
    finally {
      try { await prisma.$disconnect(); }
      finally {
        for (const [key, value] of original) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}
const sanitized = (error: unknown): boolean => error instanceof Error && error.message === 'DOC_START_FAILED' && !error.cause;

test('enabled module rejects real nonprivate staging, sanitizes failure and safely retries', async () => {
  await fixture(async documentModule => {
    const attempts = await Promise.allSettled([documentModule.start(), documentModule.start()]);
    assert.equal(attempts.length, 2);
    for (const attempt of attempts) {
      assert.equal(attempt.status, 'rejected');
      if (attempt.status === 'rejected') assert.ok(sanitized(attempt.reason));
    }
    await assert.rejects(documentModule.start(), sanitized);
  });
});

test('missing actual staging fails closed instead of creating a new private workspace', async () => {
  await fixture(async documentModule => { await assert.rejects(documentModule.start(), sanitized); }, true);
});

test('close during actual filesystem preflight waits for sanitized unwind and permanently closes admission', async () => {
  await fixture(async documentModule => {
    const pending = assert.rejects(documentModule.start(), sanitized);
    await documentModule.close();
    await pending;
    await assert.rejects(documentModule.start(), { message: 'DOC_MODULE_CLOSED' });
    await documentModule.close();
  });
});

test('enabled but never started documentModule releases resources and cannot start after close', async () => {
  await fixture(async documentModule => {
    await documentModule.close();
    await assert.rejects(documentModule.start(), { message: 'DOC_MODULE_CLOSED' });
  });
});
