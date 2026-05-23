'use strict';

const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { toStrictOpenAISchema } = require('../src/services/agents/task-contract-resolver');
const { taskContractSchema } = require('../src/services/agents/task-contract-schema');
const redisResilience = require('../src/services/agents/redis-resilience');

test('document parser orchestrator boot-imports from services path', () => {
  const orchestrator = require('../src/services/document-pipeline/parser-orchestrator');
  assert.equal(typeof orchestrator.parseFileWithBestParser, 'function');
  assert.equal(typeof orchestrator.pipelineQualityScore, 'function');
});

test('OpenAI strict TaskContract schema requires every object property recursively', () => {
  const strict = toStrictOpenAISchema(taskContractSchema);
  const successTestItem = strict.properties.success_tests.items;
  assert.deepEqual(
    successTestItem.required.slice().sort(),
    Object.keys(successTestItem.properties).sort(),
  );
  assert.ok(successTestItem.required.includes('check'));
  assert.ok(successTestItem.required.includes('parameters'));

  const executionStep = strict.properties.execution_plan.items;
  assert.deepEqual(
    executionStep.required.slice().sort(),
    Object.keys(executionStep.properties).sort(),
  );
});

test('Redis end event marks queue unhealthy so routes skip enqueue attempts', () => {
  redisResilience.clearRedisFailureMarker();
  const warnings = [];
  const fakeConnection = new EventEmitter();
  redisResilience.attachRedisListeners(fakeConnection, {
    label: 'agent-task-queue',
    logger: { warn: (msg) => warnings.push(String(msg)), error: () => {} },
  });

  fakeConnection.emit('end');

  assert.equal(redisResilience.isRedisRecentlyUnhealthy(60_000), true);
  assert.match(redisResilience.getLastRedisFailureMessage(), /connection ended/i);
  assert.ok(warnings.some((msg) => /connection ended/i.test(msg)));
  redisResilience.clearRedisFailureMarker();
});

test('invalid DOCX fails with a concise unreadable attachment error', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-invalid-docx-'));
  const filePath = path.join(tmp, 'broken.docx');
  await fs.writeFile(filePath, 'this is not an office zip');
  const fileProcessor = require('../src/services/fileProcessor');

  await assert.rejects(
    () => fileProcessor.processWord(filePath),
    /Word document is not a readable DOCX zip/i,
  );
});
