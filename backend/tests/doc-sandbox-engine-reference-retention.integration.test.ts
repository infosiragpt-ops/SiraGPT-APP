import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { AnthropicSandboxEngine } from '../src/modules/doc-sandbox/engine/anthropic-engine';
import type { DocumentProviderClient } from '../src/modules/doc-sandbox/engine/provider-client';
import type { AnthropicEngineConfig, EnginePersistence } from '../src/modules/doc-sandbox/engine/types';
import { sha256 } from '../src/modules/doc-sandbox/engine/artifacts';
import { totalTokens } from '../src/modules/doc-sandbox/engine/cost';
import { EDITOR_PROMPT_VERSION } from '../src/modules/doc-sandbox/agent/prompt';
import { DocSandboxError } from '../src/modules/doc-sandbox/types/errors';
import type { InputFile } from '../src/modules/doc-sandbox/types/contracts';
import { DocSandboxRepository, type AttemptLease } from '../src/modules/doc-sandbox/queue/repository';
import { createDocumentModelCatalogFixture } from './doc-sandbox-model-catalog-fixture';

// Real PostgreSQL ledger + real engine; only the provider boundary is doubled.
// No storage or document validator is installed/replaced, and no output is validated.
const rawUrl = process.env.DOC_SANDBOX_TEST_DATABASE_URL;
assert.ok(rawUrl, 'An isolated real PostgreSQL fixture is required; never skip this suite');
const url = new URL(rawUrl);
assert.ok(['127.0.0.1', 'localhost', '[::1]', 'doc-sandbox-test-postgres'].includes(url.hostname));
const schema = `doc_sandbox_test_${randomUUID().replaceAll('-', '')}`;
url.searchParams.set('schema', schema);
url.searchParams.set('connection_limit', '5');
const admin = new PrismaClient({ datasources: { db: { url: rawUrl } } });
const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
const repository = new DocSandboxRepository(db);
const owner = 'reference-retention-owner';
let initialized = false;
const prices = { version: 'reference-test-v1', inputPerMillionUsd: 1, outputPerMillionUsd: 2,
  cacheReadPerMillionUsd: 0, cacheWritePerMillionUsd: 0, executionPerHourUsd: 0, minimumExecutionSeconds: 0 };
const model = { id: 'fixture-mechanical', prices, maxOutputTokensPerTurn: 1024, reservationUsdPerTurn: 0.1 };
const config: AnthropicEngineConfig = { models: { mechanical: model, academic: { ...model, id: 'fixture-academic' } },
  skillVersions: {}, maxFileBytes: 1024, maxOutputBytes: 8192, maxSessionMs: 60_000,
  apiTimeoutMs: 1000, cleanupTimeoutMs: 1000 };
const isProviderFailure = (error: unknown) => error instanceof DocSandboxError && error.code === 'E_PROVIDER';

before(async () => {
  assert.match(schema, /^doc_sandbox_test_[a-f0-9]{32}$/);
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  initialized = true;
  await db.$executeRaw(Prisma.sql`CREATE TABLE users(id TEXT PRIMARY KEY,"deletedAt" TIMESTAMPTZ,plan TEXT NOT NULL DEFAULT 'PRO',"isSuperAdmin" BOOLEAN NOT NULL DEFAULT false,"apiUsage" BIGINT NOT NULL DEFAULT 0,"monthlyLimit" BIGINT NOT NULL DEFAULT 10000000)`);
  await db.$executeRaw(Prisma.sql`CREATE TABLE api_usage(id TEXT PRIMARY KEY,"userId" TEXT REFERENCES users(id) ON DELETE CASCADE,model TEXT,tokens BIGINT,cost DOUBLE PRECISION,timestamp TIMESTAMPTZ)`);
  await createDocumentModelCatalogFixture(db);
  const migration = readFileSync(resolve(__dirname, '../prisma/migrations/20260905000000_doc_sandbox_core/migration.sql'), 'utf8');
  for (const statement of migration.replace(/^--.*$/gm, '').split(';').map(part => part.trim()).filter(Boolean)) {
    await db.$executeRawUnsafe(statement);
  }
  await db.$executeRaw(Prisma.sql`INSERT INTO users(id) VALUES(${owner})`);
});
after(async () => {
  // Always disconnect both clients; only this generated fixture schema is dropped.
  try {
    await db.$disconnect();
  } finally {
    try { if (initialized) await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await admin.$disconnect(); }
  }
});

function realLedger(lease: AttemptLease): EnginePersistence {
  const money = (value: number) => (Math.ceil(value * 100_000_000) / 100_000_000).toFixed(8);
  return {
    sessionCreated: async session => { await repository.recordSession(lease, session.id); },
    containerCreated: async (_session, reference) => { await repository.recordContainer(lease, reference); },
    fileChanged: async (_session, reference) => {
      if (reference.state === 'known') await repository.recordProviderFiles(lease, [reference.id]);
      else await repository.markProviderFileDeleted(lease.jobId, reference.id, reference.state === 'deleted');
    },
    reserve: async (_session, reservation) => {
      assert.equal(await repository.reserveCost(lease, reservation.requestId, money(reservation.usd)), true);
    },
    settle: async (_session, settlement) => {
      if (!settlement.uncertain && settlement.usage.costUsd !== null) {
        await repository.settleCost(lease, settlement.requestId, money(settlement.usage.costUsd), totalTokens(settlement.usage));
      }
    },
    usageChanged: async (_session, usage) => {
      const state = await repository.getInternal(lease.jobId);
      await repository.recordUsage(lease, { ...usage }, state.costUsd);
    },
  };
}

async function verifyRejectedResponse(family: 'bash_code_execution' | 'code_execution', malformed: boolean): Promise<void> {
  const data = Buffer.from('Synthetic 2026\n');
  const input: InputFile = { id: 'reference-input', name: 'Informe.txt', format: 'txt', mime: 'text/plain', data, sha256: sha256(data) };
  const { job } = await repository.createJob({ userId: owner, idempotencyKey: randomUUID(), payloadHash: input.sha256,
    instructionsKey: `private-fixture/${randomUUID()}/instructions`, inputs: [{ kind: 'input', filename: input.name,
      storageKey: `private-fixture/${randomUUID()}/input`, mime: input.mime, size: data.length, sha256: input.sha256 }],
    modelTier: 'mechanical', requestedModel: model.id, maxTokens: 1000, maxCostUsd: '5',
    promptVersion: EDITOR_PROMPT_VERSION, expiresAt: new Date(Date.now() + 86400_000), ready: true });
  const lease = await repository.claimAttempt(job.id, 60_000); assert.ok(lease);
  await repository.transition(lease, 'planning');
  const suffix = randomUUID().replaceAll('-', '');
  const uploadId = `file_input_${suffix}`;
  const outputIds = [`file_before_${suffix}`, `file_after_${suffix}`];
  const unrelatedId = `file_prose_${suffix}`;
  const containerId = `container_${suffix}`;
  const known = new Set<string>();
  const deletions: string[] = [];
  let calls = 0;
  let metadataCalls = 0;
  let downloadCalls = 0;
  const provider: DocumentProviderClient = {
    upload: async bytes => {
      known.add(uploadId);
      return { id: uploadId, filename: 'input-0.txt', size_bytes: bytes.length, mime_type: 'text/plain', downloadable: false };
    },
    message: async () => {
      calls += 1;
      outputIds.forEach(id => known.add(id));
      const ids: unknown[] = malformed ? [outputIds[0], '../not_a_file', outputIds[1]] : outputIds;
      // The sole cast intentionally supplies a malformed external SDK response.
      // The IDs on both sides are otherwise valid generated tool references.
      return { id: `msg_${suffix}`, role: 'assistant', model: model.id, type: 'message', stop_reason: malformed ? 'pause_turn' : 'max_tokens',
        container: { id: containerId, expires_at: new Date(Date.now() + 60_000).toISOString(), skills: [] },
        usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'text', text: unrelatedId }, { type: 'container_upload', file_id: unrelatedId },
          { type: `${family}_tool_result`, tool_use_id: 'srvtool_reference_test', content: {
            type: `${family}_result`, return_code: 0, stdout: '', stderr: '',
            content: ids.map(file_id => ({ type: `${family}_output`, file_id })),
          } }],
      } as unknown as BetaMessage;
    },
    metadata: async () => { metadataCalls += 1; throw new Error('Unexpected SDK metadata request'); },
    download: async () => { downloadCalls += 1; throw new Error('Unexpected SDK download request'); },
    delete: async id => { assert.ok(known.delete(id), 'Only a known SDK file may be deleted'); deletions.push(id); },
  };
  const engine = new AnthropicSandboxEngine(provider, config, realLedger(lease));
  const session = await engine.createSession({ id: job.id, userId: owner, attempt: lease.attempt, promptVersion: EDITOR_PROMPT_VERSION });
  try {
    await engine.uploadInputs(session, [input]);
    const observedAt = Date.now();
    await assert.rejects(engine.run(session, { stage: 'plan', instructions: 'Do not change anything', mode: 'preserve',
      formats: ['txt'], skills: [], modelTier: 'mechanical', requestedModel: model.id,
      budget: { maxTurns: 2, maxTokens: 1000, maxCostUsd: 5, timeoutMs: 60_000 } }, () => {}), isProviderFailure);
    assert.equal(calls, 1, 'Protocol rejection must never trigger another paid request');
    assert.equal(metadataCalls, 0, 'A rejected response must not inspect exports');
    assert.equal(downloadCalls, 0, 'A rejected response must not download exports');
    await assert.rejects(engine.downloadOutputs(session), error => error instanceof DocSandboxError && error.code === 'E_CONFLICT');
    const recorded = await repository.getInternal(job.id);
    assert.deepEqual(recorded.providerFiles.map(file => file.fileId).sort(), [uploadId, ...outputIds].sort(),
      'A malformed sibling must not erase the cleanup obligations for valid generated references');
    assert.ok(recorded.providerFiles.every(file => !file.deleted && file.attempt === lease.attempt));
    assert.equal(recorded.providerContainers.length, 1);
    assert.equal(recorded.providerContainers[0]!.id, containerId);
    assert.ok(Date.parse(recorded.providerContainers[0]!.expiresAt!) >= observedAt + 30 * 86400_000);
    assert.equal(recorded.costReservations.length, 1);
    assert.equal(recorded.costReservations[0]!.actualUsd, '0.00018000');
    assert.equal(recorded.costReservations[0]!.actualTokens, 140);
    assert.equal(recorded.costUsd, '0.00018'); // Prisma's numeric projection removes trailing zeroes.
    assert.equal(recorded.usage.inputTokens, 100);
    assert.equal(recorded.status, 'planning');
    assert.equal(recorded.fence, lease.fence);
    assert.equal(recorded.cleanupPending, true);
    assert.deepEqual(await repository.artifactsOwned(job.id, owner), []);
    assert.ok((await repository.listEventsOwned(job.id, owner)).every(event => event.payload.status !== 'done'));
  } finally {
    await engine.destroy(session);
  }
  assert.deepEqual(deletions.sort(), [uploadId, ...outputIds].sort());
  assert.equal(known.size, 0);
  const cleaned = await repository.getInternal(job.id);
  assert.ok(cleaned.providerFiles.every(file => file.deleted));
  assert.equal(cleaned.providerContainers.length, 1, 'File deletion is not proof of container deletion');
  assert.equal(cleaned.cleanupPending, true);
}

test('real ledger records valid references and container even when the response stops with max_tokens', async () => {
  await verifyRejectedResponse('bash_code_execution', false);
});
for (const family of ['bash_code_execution', 'code_execution'] as const) {
  test(`real ledger retains both valid references around a malformed ${family} output`, async () => {
    await verifyRejectedResponse(family, true);
  });
}
