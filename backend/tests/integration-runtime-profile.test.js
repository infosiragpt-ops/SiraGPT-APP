'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildUniversalTaskContract } = require('../src/services/agents/universal-task-contract');
const {
  buildIntegrationInput,
  buildIntegrationRuntimeProfile,
  extensionToFormat,
} = require('../src/services/ai-product-os/integration-runtime-profile');

test('integration-runtime-profile maps contract to integration input', () => {
  const contract = buildUniversalTaskContract({
    rawUserRequest: 'Crea un informe académico en DOCX con citas APA, fórmulas LaTeX y gráficos.',
    fileIds: ['paper.pdf'],
  });
  const input = buildIntegrationInput({
    contract,
    semanticIntentAnalysis: {
      structured_intent: {
        intent_primary: 'professional_document_generation',
        intent_secondary: ['scientific_research'],
        required_tools: ['citation_formatter', 'latex_renderer'],
        final_output: 'docx',
      },
      skill_plan: {
        output_formats: ['docx', 'pdf'],
        selected_skills: ['academic_report'],
      },
    },
    fileIds: ['paper.pdf'],
  });

  assert.equal(input.primaryIntent, contract.primary_intent);
  assert.ok(input.outputFormats.includes('docx'));
  assert.ok(input.requiredTools.includes('citation_formatter'));
  assert.ok(input.requiredTools.includes('latex_renderer'));
  assert.equal(input.requiresResearch, true);
  assert.equal(input.requiresFileProcessing, true);
});

test('integration-runtime-profile builds compact prompt-safe readiness', () => {
  const contract = buildUniversalTaskContract({
    rawUserRequest: 'Analiza este PDF y devuelve un Word con ecuaciones en LaTeX, referencias APA y gráficos.',
    fileIds: ['analysis.pdf'],
  });
  const profile = buildIntegrationRuntimeProfile({
    contract,
    fileIds: ['analysis.pdf'],
    env: { OPENAI_API_KEY: 'sk-secret-value-that-must-not-leak' },
  });

  assert.equal(profile.schema_version, 'sira.integration_runtime_profile.v1');
  assert.ok(profile.promptProfile.selected_layers.includes('document'));
  assert.ok(profile.promptProfile.package_inventory.expanded_library_catalog_count >= 1000);
  assert.ok(profile.promptProfile.package_inventory.math_typesetting_ready.includes('katex'));
  assert.doesNotMatch(JSON.stringify(profile.promptProfile), /sk-secret-value-that-must-not-leak/);
});

test('integration-runtime-profile normalizes common document formats', () => {
  assert.equal(extensionToFormat('.docx'), 'docx');
  assert.equal(extensionToFormat('application/pdf'), 'pdf');
  assert.equal(extensionToFormat('text/markdown'), 'md');
  assert.equal(extensionToFormat('application/x-latex'), 'tex');
});
