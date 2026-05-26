const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSemanticIntentAnalysis,
} = require('../src/services/agents/semantic-intent-router');
const {
  SIRA_EXECUTION_LAW,
  UNIVERSAL_INTENT_TAXONOMY,
  validateCiraCognitiveTaskEnvelope,
} = require('../src/services/agents/cira-cognitive-task-envelope');

test('Cira envelope compiles complex Word/PDF + Excel analysis into a validated operating object', () => {
  const analysis = buildSemanticIntentAnalysis({
    rawUserRequest: 'Hazme un informe profesional en Word con fuentes científicas reales, analiza este Excel, crea gráficos y dame también PDF.',
    files: [
      {
        id: 'file_001',
        name: 'datos_estudiantes.xlsx',
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: 248391,
      },
    ],
    userId: 'user_456',
    chatId: 'conv_123',
  });

  const envelope = analysis.cira_task_envelope;
  assert.equal(validateCiraCognitiveTaskEnvelope(envelope).ok, true);
  assert.equal(envelope.schema_version, 'sira.task_envelope.v1');
  assert.equal(envelope.intent_analysis.primary_intent.id, 'complex_academic_document_generation');
  assert.deepEqual(envelope.entities.requested_formats, ['docx', 'pdf']);
  assert.equal(envelope.raw_input.attachments[0].detected_type, 'spreadsheet');
  assert.ok(envelope.context_requirements.needs_uploaded_files);
  assert.ok(envelope.context_requirements.needs_scientific_apis);
  assert.ok(envelope.tool_plan.required_tools.some((tool) => tool.tool_name === 'spreadsheet_reader'));
  assert.ok(envelope.tool_plan.required_tools.some((tool) => tool.tool_name === 'web_search'));
  assert.ok(envelope.tool_plan.required_tools.some((tool) => tool.tool_name === 'doi_validator'));
  assert.ok(envelope.output_contract.primary_output.format === 'docx');
  assert.ok(envelope.output_contract.secondary_outputs.some((output) => output.format === 'pdf'));
  assert.ok(envelope.frames.intent_frame.secondary_intents.includes('apa7_citation'));
  assert.ok(envelope.frames.artifact_frame.artifacts.some((artifact) => artifact.format === 'docx'));
  assert.ok(envelope.frames.artifact_frame.artifacts.some((artifact) => artifact.format === 'pdf'));
});

test('Cira envelope exposes contract law and universal taxonomy for every route', () => {
  const analysis = buildSemanticIntentAnalysis({
    rawUserRequest: 'Crea una landing profesional para vender un curso de inteligencia artificial',
  });
  const envelope = analysis.cira_task_envelope;

  assert.equal(envelope.intent_analysis.primary_intent.id, 'landing_page_generation');
  assert.equal(envelope.entities.requested_formats[0], 'html');
  assert.equal(envelope.task_classification.requires_code_execution, true);
  assert.ok(envelope.tool_plan.required_tools.some((tool) => tool.tool_name === 'run_tests'));
  assert.ok(envelope.frames.plan_frame.steps.some((step) => step.id === 'tool_runtime_gateway'));

  for (const [key, value] of Object.entries(SIRA_EXECUTION_LAW)) {
    assert.equal(envelope.execution_law[key], value, key);
  }
  assert.ok(UNIVERSAL_INTENT_TAXONOMY.coding.includes('landing_page_generation'));
  assert.ok(UNIVERSAL_INTENT_TAXONOMY.document_artifacts.includes('docx_generation'));
});

test('Cira envelope separates image and video generation from document tools', () => {
  const image = buildSemanticIntentAnalysis({
    rawUserRequest: 'Genera una imagen realista de un auto deportivo rojo en una ciudad futurista',
  }).cira_task_envelope;
  const video = buildSemanticIntentAnalysis({
    rawUserRequest: 'Haz un video de 10 segundos mostrando una botella de perfume de lujo girando sobre una mesa negra',
  }).cira_task_envelope;

  assert.equal(image.intent_analysis.primary_intent.id, 'image_generation');
  assert.deepEqual(image.entities.requested_formats, ['png']);
  assert.ok(image.tool_plan.required_tools.some((tool) => tool.tool_name === 'image_generation_api'));
  assert.equal(image.tool_plan.required_tools.some((tool) => tool.tool_name === 'create_document'), false);

  assert.equal(video.intent_analysis.primary_intent.id, 'video_generation');
  assert.deepEqual(video.entities.requested_formats, ['mp4']);
  assert.ok(video.tool_plan.required_tools.some((tool) => tool.tool_name === 'video_generation_api'));
  assert.ok(video.frames.artifact_frame.artifacts.some((artifact) => artifact.format === 'mp4'));
});

test('Cira envelope preserves input-file context and does not fabricate xlsx output for "analiza este Excel"', () => {
  const analysis = buildSemanticIntentAnalysis({
    rawUserRequest: 'Hazme un Word con fuentes reales, analiza este Excel y dame PDF',
    files: [{ id: 'dataset', name: 'dataset.xlsx' }],
  });
  const formats = analysis.cira_task_envelope.entities.requested_formats;

  assert.deepEqual(formats, ['docx', 'pdf']);
  assert.equal(formats.includes('xlsx'), false);
  assert.ok(analysis.cira_task_envelope.entities.data_files.some((file) => file.file_id === 'dataset'));
});
