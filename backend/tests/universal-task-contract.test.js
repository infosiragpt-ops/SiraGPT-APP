const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildUniversalTaskContract,
  validateUniversalTaskContract,
  deriveLegacyTaskContract,
  enforceLegacyTaskContract,
  buildUniversalContractPrompt,
  createFailureReport,
  buildRegressionPrompts,
  TOOL_MANIFESTS,
} = require('../src/services/agents/universal-task-contract');

test('universal contract locks SVG requests to image/svg+xml', () => {
  const contract = buildUniversalTaskContract({ rawUserRequest: 'Créame un SVG de una casa con techo rojo y dos ventanas' });

  assert.equal(contract.pipeline, 'VisualArtifactPipeline');
  assert.equal(contract.artifact_type, 'svg');
  assert.equal(contract.required_extension, '.svg');
  assert.equal(contract.mime_type, 'image/svg+xml');
  assert.ok(contract.validation_plan.some((item) => item.check === 'parses_as_svg'));
  assert.equal(validateUniversalTaskContract(contract).ok, true);
});

test('universal contract routes Word, Excel and PowerPoint by sovereign format', () => {
  const word = buildUniversalTaskContract({ rawUserRequest: 'Hazme un Word académico APA 7' });
  const excel = buildUniversalTaskContract({ rawUserRequest: 'Genera un Excel con 40 artículos reales y DOI' });
  const ppt = buildUniversalTaskContract({ rawUserRequest: 'Crea una presentación PowerPoint ejecutiva' });

  assert.equal(word.pipeline, 'DocumentPipeline');
  assert.equal(word.required_extension, '.docx');
  assert.equal(excel.pipeline, 'SpreadsheetPipeline');
  assert.equal(excel.required_extension, '.xlsx');
  assert.equal(excel.source_requirements.verification_policy, 'strict');
  assert.ok(excel.required_tools.includes('web_search'));
  assert.equal(ppt.pipeline, 'SlidePipeline');
  assert.equal(ppt.required_extension, '.pptx');
});

test('input PDF analysis is RAG understanding, not PDF generation', () => {
  const contract = buildUniversalTaskContract({
    rawUserRequest: 'Analiza este PDF y dame un resumen',
    fileIds: ['file_1'],
  });

  assert.equal(contract.pipeline, 'RAGDocumentUnderstandingPipeline');
  assert.equal(contract.required_extension, null);
  assert.equal(contract.artifact_required, false);
  assert.ok(contract.required_tools.some((tool) => tool === 'rag_retrieve' || tool === 'self_rag_answer'));
});

test('plain transcription of an uploaded file stays inline and does not generate DOCX', () => {
  const contract = buildUniversalTaskContract({
    rawUserRequest: 'transcribir este archivo',
    fileIds: ['file_1'],
  });

  assert.equal(contract.pipeline, 'RAGDocumentUnderstandingPipeline');
  assert.equal(contract.primary_intent, 'document_understanding');
  assert.equal(contract.required_extension, null);
  assert.equal(contract.artifact_required, false);
  assert.equal(contract.delivery_mode, 'inline-chat');
  assert.ok(contract.required_tools.includes('self_rag_answer'));
  assert.ok(!contract.required_tools.includes('create_document'));
  assert.ok(contract.user_constraints.includes('transcription_mode:verbatim_inline_no_summary_no_document'));
  assert.ok(contract.ambiguity_score < 0.8);
});

test('explicit Word transcription still routes to DOCX artifact generation', () => {
  const contract = buildUniversalTaskContract({
    rawUserRequest: 'transcribir este archivo en Word profesional',
    fileIds: ['file_1'],
  });

  assert.equal(contract.pipeline, 'DocumentPipeline');
  assert.equal(contract.required_extension, '.docx');
  assert.equal(contract.artifact_required, true);
  assert.ok(contract.required_tools.includes('create_document'));
  assert.ok(contract.required_tools.includes('verify_artifact'));
});

test('research plus multiple deliverables creates a MultiIntent DAG', () => {
  const contract = buildUniversalTaskContract({
    rawUserRequest: 'Busca 40 artículos reales con DOI, entrégalos en Excel y luego redacta el método en Word',
  });

  assert.equal(contract.pipeline, 'MultiIntentPipeline');
  assert.equal(contract.multi_intent_dag.enabled, true);
  assert.ok(contract.multi_intent_dag.nodes.some((node) => node.pipeline === 'ResearchGroundingPipeline'));
  assert.ok(contract.multi_intent_dag.nodes.some((node) => node.required_extension === '.xlsx'));
  assert.ok(contract.multi_intent_dag.nodes.some((node) => node.required_extension === '.docx'));
  assert.ok(contract.multi_intent_dag.edges.some((edge) => edge.from === 'research_1'));
});

test('negated output and no-internet directives do not create unwanted tools', () => {
  const noWord = buildUniversalTaskContract({ rawUserRequest: 'dame 10 fuentes sobre IA sin Word' });
  const noInternet = buildUniversalTaskContract({ rawUserRequest: 'dame 10 fuentes sobre IA sin internet' });

  assert.equal(noWord.pipeline, 'ResearchGroundingPipeline');
  assert.equal(noWord.artifact_required, false);
  assert.equal(noWord.multi_intent_dag.enabled, false);
  assert.equal(noWord.required_extension, null);
  assert.ok(noWord.required_tools.includes('web_search'));

  assert.equal(noInternet.pipeline, 'DirectAnswerPipeline');
  assert.equal(noInternet.source_requirements.required, false);
  assert.ok(!noInternet.required_tools.includes('web_search'));
  assert.ok(noInternet.forbidden_tools.includes('web_search'));
  assert.ok(noInternet.user_constraints.includes('no_external_search:user_requested'));
});

test('freshness questions require grounded web search', () => {
  const contract = buildUniversalTaskContract({ rawUserRequest: 'qué pasó hoy con OpenAI' });

  assert.equal(contract.pipeline, 'ResearchGroundingPipeline');
  assert.equal(contract.source_requirements.required, true);
  assert.ok(contract.required_tools.includes('web_search'));
});

test('web product requests compile to the code pipeline before UI routing', () => {
  const contract = buildUniversalTaskContract({
    rawUserRequest: 'crea una web de una empresa de carros',
  });

  assert.equal(contract.pipeline, 'CodePipeline');
  assert.equal(contract.primary_intent, 'code_generation');
  assert.equal(contract.required_extension, '.html');
  assert.ok(contract.required_tools.includes('run_tests'));
});

test('legacy TaskContract adapter cannot override UniversalTaskContract format sovereignty', () => {
  const universal = buildUniversalTaskContract({ rawUserRequest: 'Créame un SVG de una casa' });
  const wrongLegacy = {
    version: '1.0',
    user_intent: 'wrong',
    artifact_type: 'document',
    required_extension: 'docx',
    mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    delivery_mode: 'downloadable-file',
    content_requirements: [],
    forbidden_outputs: [],
    ambiguity_level: 'low',
    clarifying_questions: [],
    success_tests: [],
  };

  const enforced = enforceLegacyTaskContract(wrongLegacy, universal);

  assert.equal(enforced.artifact_type, 'svg');
  assert.equal(enforced.required_extension, 'svg');
  assert.equal(enforced.mime_type, 'image/svg+xml');
  assert.ok(enforced.success_tests.some((testCase) => testCase.check === 'parses_as_svg'));
});

test('prompt block contains contract rules without raw hidden leakage requirements', () => {
  const contract = buildUniversalTaskContract({ rawUserRequest: 'Dame una respuesta directa sobre Bayes' });
  const prompt = buildUniversalContractPrompt(contract);

  assert.match(prompt, /UNIVERSAL TASK CONTRACT/);
  assert.match(prompt, /Execute exactly this validated contract/);
  assert.match(prompt, /do not reveal to user/);
});

test('tool manifests are strict enough to prevent invented free-form tools', () => {
  for (const name of ['web_search', 'rag_retrieve', 'create_document', 'verify_artifact', 'python_exec', 'run_tests', 'finalize']) {
    const manifest = TOOL_MANIFESTS[name];
    assert.ok(manifest, `missing manifest ${name}`);
    assert.equal(manifest.name, name);
    assert.ok(manifest.purpose);
    assert.ok(manifest.input_schema);
    assert.ok(manifest.output_schema);
    assert.ok(Array.isArray(manifest.acceptance_tests));
    assert.ok(manifest.recovery_policy);
  }
});

test('failure report schema supports mandatory self-repair loop', () => {
  const report = createFailureReport({
    failedStage: 'format_validation',
    expectedOutput: '.svg',
    actualOutput: '.docx',
    rootCause: 'extension mismatch',
    repairStrategy: 'regenerate as SVG',
    retryCount: 1,
    testsReexecuted: ['extension_match'],
  });

  assert.equal(report.failed_stage, 'format_validation');
  assert.equal(report.release_decision, 'blocked');
  assert.deepEqual(report.tests_reexecuted, ['extension_match']);
});

test('create_document blocks wrong-format files before artifact registration when contract fails', async () => {
  process.env.AGENT_ARTIFACT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-contract-artifacts-'));
  const { INTERNAL } = require('../src/services/agents/task-tools');
  const universal = buildUniversalTaskContract({ rawUserRequest: 'Créame un SVG de una casa' });
  const taskContract = deriveLegacyTaskContract(universal);
  const events = [];

  const result = await INTERNAL.createDocument.execute({
    filename: 'wrong.docx',
    python: [
      'import os',
      'with open(os.environ["OUT_PATH"], "w", encoding="utf-8") as f:',
      '    f.write("<svg></svg>")',
    ].join('\n'),
    description: 'wrong format on purpose',
  }, {
    userId: 'user-a',
    chatId: 'chat-a',
    taskContract,
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /Format Sovereignty/);
  assert.equal(result.failureReport.release_decision, 'blocked');
  assert.equal(events.some((event) => event.type === 'file_artifact'), false);
});

test('contract regression framework covers 1000 deterministic intent/format cases', () => {
  const prompts = buildRegressionPrompts();
  assert.ok(prompts.length >= 1000);

  for (const { prompt, expectedExtension } of prompts) {
    const contract = buildUniversalTaskContract({ rawUserRequest: prompt });
    assert.equal(
      contract.required_extension,
      expectedExtension,
      `format confusion for prompt: ${prompt}`,
    );
    assert.equal(validateUniversalTaskContract(contract).ok, true);
  }
});
