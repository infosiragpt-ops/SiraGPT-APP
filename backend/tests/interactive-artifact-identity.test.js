'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Execute the real modules with only their external service boundary replaced.
// No provider request, database, environment file or HTTP listener is needed.
function load(relative, dependencies) {
  const filename = path.resolve(__dirname, relative);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports,
    require: (name) => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name),
    process: { env: {} }, console,
    AbortController, setInterval: () => 1, clearInterval: () => {},
  }, { filename });
  return module.exports;
}
function generator() {
  class Provider {
    constructor() {
      this.chat = { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({
        id: 'model-chosen-id', title: 'Agenda', jsx: 'const App = () => <div>Agenda</div>', explanation: 'Agenda interactiva',
      }) } }] }) } };
    }
  }
  return load('../src/services/artifact-generator.js', { openai: Provider });
}

test('new generations receive independent server identities, not model/code/title identities', async () => {
  const service = generator();
  const first = await service.generateArtifact({ prompt: 'Una agenda', model: 'synthetic-model' });
  const second = await service.generateArtifact({ prompt: 'Una agenda', model: 'synthetic-model' });
  assert.match(first.file.id, /^[0-9a-f-]{36}$/);
  assert.notEqual(first.file.id, 'model-chosen-id');
  assert.notEqual(first.file.id, second.file.id);
  assert.equal(first.file.jsx, second.file.jsx);
  assert.equal(JSON.parse(JSON.stringify(first.file)).id, first.file.id);
});

test('the final SSE response and persisted message carry the same id and owning chat', async () => {
  const records = [];
  const ownershipChecks = [];
  const prisma = {
    chat: {
      findFirst: async ({ where }) => { ownershipChecks.push(where); return where.id === 'chat-a' && where.userId === 'owner-a' ? { id: 'chat-a' } : null; },
      update: async () => {},
    },
    message: { create: async ({ data }) => {
      const record = { id: `message-${records.length}`, ...data };
      records.push(record);
      return record;
    } },
  };
  const router = load('../src/routes/artifact.js', {
    '../middleware/auth': { authenticateToken: () => {} },
    '../config/database': prisma,
    '../services/artifact-generator': generator(),
  });
  const handler = router.stack.find((entry) => entry.route?.path === '/generate').route.stack.at(-1).handle;
  const response = new EventEmitter();
  let stream = '';
  Object.assign(response, {
    setHeader() {}, flushHeaders() {}, write(chunk) { stream += chunk; }, end() { this.writableEnded = true; },
  });
  await handler({ body: { prompt: 'Una agenda', displayPrompt: 'Una agenda', chatId: 'chat-a', model: 'synthetic-model' }, user: { id: 'owner-a' } }, response);
  const final = stream.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6))).find((event) => event.type === 'final');
  assert.ok(final);
  assert.equal(final.assistantMessage.chatId, 'chat-a');
  assert.equal(final.assistantMessage.id, records[1].id);
  assert.equal(final.file.id, final.assistantMessage.files[0].id);
  assert.equal(final.file.id, JSON.parse(records[1].files)[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(ownershipChecks)), [{ id: 'chat-a', userId: 'owner-a' }]);
});
