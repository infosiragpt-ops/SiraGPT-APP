'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildUniversalTaskContract } = require('../src/services/agents/universal-task-contract');
const { buildDocumentDeliveryPolicy } = require('../src/services/agents/document-delivery-policy');
const { shouldUseDeterministicAttachmentAnswer } = require('../src/services/agents/agent-task-runner');

const factualQuestion = 'Usa exclusivamente el documento adjunto para responder: ¿cuál es el código único y cuál es el presupuesto ficticio del proyecto Faro Zafiro? Cita el nombre del archivo y la sección donde aparecen ambos datos. Si no encuentras evidencia, dilo.';
const absentQuestion = 'En el documento adjunto, ¿cuál es el nombre del proveedor de energía contratado por Faro Zafiro? Si el dato no aparece, di claramente que no encontraste evidencia en el documento. No infieras un nombre, no cites una sección irrelevante y no crees archivos.';

test('a factual question about an attached document requires evidence and no generated spreadsheet', () => {
  const files = ['uploaded-docx'];
  const contract = buildUniversalTaskContract({ rawUserRequest: factualQuestion, fileIds: files });
  const policy = buildDocumentDeliveryPolicy({ goal: factualQuestion, displayGoal: factualQuestion, files });

  assert.equal(contract.primary_intent, 'document_understanding');
  assert.equal(contract.pipeline, 'RAGDocumentUnderstandingPipeline');
  assert.equal(contract.artifact_required, false);
  assert.equal(contract.required_extension, null);
  assert.equal(contract.delivery_mode, 'inline-chat');
  assert.ok(contract.required_tools.some((name) => ['rag_retrieve', 'self_rag_answer'].includes(name)));
  assert.ok(!contract.required_tools.includes('create_document'));
  assert.equal(policy.mode, 'chat_only');
  assert.equal(policy.autoGenerate, false);
  assert.equal(shouldUseDeterministicAttachmentAnswer({ goal: factualQuestion, documentPolicy: policy, files, env: {} }), false,
    'a narrow fact question needs retrieval, not sentence extraction');
});

test('an absent fact must go through evidence retrieval instead of raw document excerpt', () => {
  const files = ['uploaded-docx'];
  const contract = buildUniversalTaskContract({ rawUserRequest: absentQuestion, fileIds: files });
  const policy = buildDocumentDeliveryPolicy({ goal: absentQuestion, displayGoal: absentQuestion, files });

  assert.equal(contract.artifact_required, false);
  assert.equal(policy.mode, 'chat_only');
  assert.equal(shouldUseDeterministicAttachmentAnswer({ goal: absentQuestion, documentPolicy: policy, files, env: {} }), false);
});

test('an explicit spreadsheet request still creates the requested Excel', () => {
  const goal = 'Crea un Excel con el presupuesto ficticio del proyecto Faro Zafiro.';
  const contract = buildUniversalTaskContract({ rawUserRequest: goal });
  const policy = buildDocumentDeliveryPolicy({ goal });

  assert.equal(contract.required_extension, '.xlsx');
  assert.equal(contract.artifact_required, true);
  assert.equal(policy.mode, 'doc_required');
});

test('a general summary can keep the fast path, unlike a specific fact question', () => {
  const files = ['uploaded-docx'];
  const goal = 'Resume brevemente qué dice este documento adjunto.';
  const policy = buildDocumentDeliveryPolicy({ goal, files });
  assert.equal(policy.mode, 'chat_only');
  assert.equal(shouldUseDeterministicAttachmentAnswer({ goal, documentPolicy: policy, files, env: {} }), true);
});
