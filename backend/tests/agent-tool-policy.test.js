const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildForbiddenToolNames,
  filterTaskTools,
  isPrivateDocumentOnlyRequest,
  wantsExternalResearch,
} = require('../src/services/agents/agent-tool-policy');

test('agent tool policy: private document source wording disables external search tools', () => {
  const options = {
    goal: 'Usando los documentos adjuntos, calcula cifras y dame fuentes por documento.',
    fileIds: ['file-docx', 'file-pdf'],
    documentPolicy: { mode: 'chat_only', autoGenerate: false },
    executionProfile: { capabilities: { needsPrivateContext: true } },
    universalTaskContract: { grounding_required: true },
  };

  assert.equal(isPrivateDocumentOnlyRequest(options), true);
  const forbidden = buildForbiddenToolNames(options);
  assert.equal(forbidden.has('web_search'), true);
  assert.equal(forbidden.has('read_url'), true);
  assert.equal(forbidden.has('scientific_search'), true);
  assert.equal(forbidden.has('create_document'), true);
  assert.equal(forbidden.has('verify_artifact'), true);

  const tools = filterTaskTools([
    { name: 'web_search' },
    { name: 'rag_retrieve' },
    { name: 'python_exec' },
  ], options);
  assert.deepEqual(tools.map((tool) => tool.name), ['rag_retrieve', 'python_exec']);
});

test('agent tool policy: explicit external research keeps web search available', () => {
  const options = {
    goal: 'Resume los documentos adjuntos y busca fuentes externas recientes en la web.',
    fileIds: ['file-docx'],
    documentPolicy: { mode: 'chat_only', autoGenerate: false },
  };

  assert.equal(wantsExternalResearch(options.goal), true);
  assert.equal(isPrivateDocumentOnlyRequest(options), false);
  assert.equal(buildForbiddenToolNames(options).has('web_search'), false);
});
