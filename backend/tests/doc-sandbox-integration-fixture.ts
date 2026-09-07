import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { CreateBucketCommand, DeleteBucketCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { DocSandboxRepository } from '../src/modules/doc-sandbox/queue/repository';
import { createPrivateDocumentS3Client, PrivateDocumentStorage, DocumentDownloadTickets } from '../src/modules/doc-sandbox/storage/private-storage';
import type { DocumentSandboxConfig } from '../src/modules/doc-sandbox/config';
import { createDocumentModelCatalogFixture } from './doc-sandbox-model-catalog-fixture';

function required(name: string): string {
  const value = process.env[name];
  assert.ok(value, `${name} is required for real integration; no service is mocked or skipped`);
  return value;
}
function isolated(url: URL, service: 'postgres' | 'minio'): void {
  assert.ok(['127.0.0.1', 'localhost', '[::1]', `doc-sandbox-test-${service}`].includes(url.hostname), `Only loopback or the explicitly named isolated ${service} test service is allowed`);
}
export async function createDocumentIntegrationFixture() {
  const databaseUrl = new URL(required('DOC_SANDBOX_TEST_DATABASE_URL'));
  const endpoint = new URL(required('DOC_SANDBOX_TEST_S3_ENDPOINT'));
  isolated(databaseUrl, 'postgres'); isolated(endpoint, 'minio');
  const accessKeyId = required('DOC_SANDBOX_TEST_S3_ACCESS_KEY_ID');
  const secretAccessKey = required('DOC_SANDBOX_TEST_S3_SECRET_ACCESS_KEY');
  const suffix = randomUUID().replaceAll('-', '');
  const schema = `doc_http_test_${suffix}`;
  const bucket = `doc-sandbox-test-${suffix}`;
  const admin = new PrismaClient({ datasources: { db: { url: databaseUrl.toString() } } });
  const scoped = new URL(databaseUrl);
  scoped.searchParams.set('schema', schema);
  const db = new PrismaClient({ datasources: { db: { url: scoped.toString() } } });
  const s3 = createPrivateDocumentS3Client({ endpoint: endpoint.toString(), region: 'us-east-1', forcePathStyle: true,
    // Exactly the runtime policy: SDK automatic retries off. PrivateDocumentStorage
    // owns bounded retries for GET/LIST/DELETE; immutable conditional PUT is not retried.
    credentials: { accessKeyId, secretAccessKey } });
  let schemaCreated = false;
  let bucketCreated = false;
  const key = randomBytes(32);
  const owner = `owner_${suffix}`;
  const other = `other_${suffix}`;
  async function close(): Promise<void> {
    await db.$disconnect();
    try {
      if (bucketCreated) {
        // The bucket is generated exclusively by this fixture. Never enumerate another bucket.
        assert.match(bucket, /^doc-sandbox-test-[a-f0-9]{32}$/);
        let cursor: string | undefined;
        do {
          const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: cursor }));
          const objects = (listed.Contents ?? []).flatMap(object => object.Key ? [{ Key: object.Key }] : []);
          if (objects.length) {
            const deleted = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
            assert.equal(deleted.Errors?.length ?? 0, 0, 'fixture objects must be removed successfully');
          }
          cursor = listed.IsTruncated ? listed.NextContinuationToken : undefined;
        } while (cursor);
        await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
      }
    } finally {
      if (schemaCreated) { assert.match(schema, /^doc_http_test_[a-f0-9]{32}$/); await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); }
      await admin.$disconnect(); s3.destroy();
    }
  }
  try {
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`); schemaCreated = true;
    await db.$executeRaw(Prisma.sql`CREATE TABLE users(id TEXT PRIMARY KEY,"deletedAt" TIMESTAMPTZ,plan TEXT NOT NULL DEFAULT 'PRO',"isSuperAdmin" BOOLEAN NOT NULL DEFAULT false,"apiUsage" BIGINT NOT NULL DEFAULT 0,"monthlyLimit" BIGINT NOT NULL DEFAULT 10000000)`);
    await db.$executeRaw(Prisma.sql`CREATE TABLE api_usage(id TEXT PRIMARY KEY,"userId" TEXT REFERENCES users(id) ON DELETE CASCADE,model TEXT,tokens BIGINT,cost DOUBLE PRECISION,timestamp TIMESTAMPTZ)`);
    // Minimal real catalog projection queried by the production document policy.
    // No provider credentials or engine are involved in admission tests.
    await createDocumentModelCatalogFixture(db);
    const migration = readFileSync(resolve(__dirname, '../prisma/migrations/20260905000000_doc_sandbox_core/migration.sql'), 'utf8');
    for (const statement of migration.replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) await db.$executeRawUnsafe(statement);
    await db.$executeRaw(Prisma.sql`INSERT INTO users(id) VALUES(${owner}),(${other})`);
    await s3.send(new CreateBucketCommand({ Bucket: bucket })); bucketCreated = true;
    const prices = { version: 'fixture-unused-no-provider', inputPerMillionUsd: 1, outputPerMillionUsd: 1,
      cacheReadPerMillionUsd: 1, cacheWritePerMillionUsd: 1, executionPerHourUsd: 0, minimumExecutionSeconds: 0 };
    const model = { id: 'fixture-unused-no-provider', prices, maxOutputTokensPerTurn: 256, reservationUsdPerTurn: 1 };
    // The router only reads limits here. No engine/validator is replaced or invoked by this fixture.
    const config: DocumentSandboxConfig = {
      redisUrl: process.env.DOC_SANDBOX_TEST_REDIS_URL ?? 'redis://127.0.0.1:1', apiKey: 'fixture-unused-no-provider',
      bucket, storageKey: key, keyId: 'test-v1', previousKeys: {}, r2AccountId: 'fixture', r2AccessKeyId: accessKeyId,
      r2SecretAccessKey: secretAccessKey, r2Endpoint: endpoint.toString(), validatorImage: `fixture-unused@sha256:${'a'.repeat(64)}`,
      validatorStagingRoot: '/tmp/doc-fixture-validator-not-invoked',
      engine: { models: { mechanical: { ...model, id: 'fixture-mechanical' }, academic: { ...model, id: 'fixture-academic' } }, skillVersions: {}, maxFileBytes: 1024 * 1024,
        maxOutputBytes: 1024 * 1024, maxSessionMs: 60_000, apiTimeoutMs: 60_000, cleanupTimeoutMs: 10_000 },
      maxCostUsd: 0, maxTurns: 2, maxTokens: 1000, timeoutMs: 60_000, retentionDays: 1, maxFileBytes: 1024 * 1024,
      concurrency: 1, showCost: true,
    };
    return { db, repository: new DocSandboxRepository(db), s3, bucket, key, owner, other, config,
      storage: new PrivateDocumentStorage(s3, { bucket, key, keyId: 'test-v1', maxBytes: 1024 * 1024 }),
      tickets: new DocumentDownloadTickets(key), close };
  } catch (error) { await close(); throw error; }
}
export type DocumentIntegrationFixture = Awaited<ReturnType<typeof createDocumentIntegrationFixture>>;
