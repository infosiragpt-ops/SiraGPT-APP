const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildUniversalTaskContract,
} = require('../src/services/agents/universal-task-contract');

test('universal task contract: sources by attached document do not require web_search', () => {
  const contract = buildUniversalTaskContract({
    rawUserRequest: 'Usando los documentos adjuntos, calcula cifras y dame fuentes por documento. No crees archivos.',
    fileIds: ['file-docx', 'file-pdf'],
  });

  assert.equal(contract.source_requirements.required, false);
  assert.equal(contract.required_tools.includes('web_search'), false);
  assert.equal(contract.required_tools.some((tool) => ['rag_retrieve', 'self_rag_answer'].includes(tool)), true);
});

test('universal task contract: explicit external sources with attachments still require web_search', () => {
  const contract = buildUniversalTaskContract({
    rawUserRequest: 'Resume el documento adjunto y busca fuentes externas recientes en la web.',
    fileIds: ['file-docx'],
  });

  assert.equal(contract.source_requirements.required, true);
  assert.equal(contract.required_tools.includes('web_search'), true);
});
