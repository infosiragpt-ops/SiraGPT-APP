const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildExecutionProfile,
  buildExecutionProfilePrompt,
  classifyAttachmentKinds,
  validateFinalize,
} = require('../src/services/agents/agentic-execution-profile');

test('agentic execution profile: requires search and document verification for academic Excel tasks', () => {
  const profile = buildExecutionProfile({
    goal: 'Investiga 40 articulos cientificos reales con DOI y ponlos en Excel',
  });

  assert.equal(profile.capabilities.needsResearch, true);
  assert.equal(profile.capabilities.needsDocument, true);
  assert.equal(profile.capabilities.strictEvidence, true);
  assert.deepEqual(profile.requiredTools, ['web_search', 'create_document', 'verify_artifact']);
  assert.equal(profile.minimumToolCalls.web_search, 2);
});

test('agentic execution profile: requires document intelligence and RAG for uploaded private context', () => {
  const profile = buildExecutionProfile({
    goal: 'Dame un resumen de este documento cargado',
    fileIds: ['file_1'],
  });

  assert.equal(profile.capabilities.needsPrivateContext, true);
  assert.ok(profile.requiredTools.includes('docintel_analyze'));
  assert.ok(profile.requiredTools.includes('rag_retrieve'));

  const blocked = validateFinalize(profile, [
    { actions: [{ tool: 'docintel_analyze', observation: { ok: true } }] },
  ]);
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.missingTools, ['rag_retrieve']);
});

test('agentic execution profile: document source wording does not trigger web research', () => {
  const profile = buildExecutionProfile({
    goal: 'Usando los documentos adjuntos, calcula cifras y dame fuentes por documento.',
    fileIds: ['file_docx', 'file_pdf'],
    fileMetadata: [
      { id: 'file_docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: 'informe.docx' },
      { id: 'file_pdf', mimeType: 'application/pdf', name: 'riesgos.pdf' },
    ],
  });

  assert.equal(profile.capabilities.needsPrivateContext, true);
  assert.equal(profile.capabilities.needsResearch, false);
  assert.ok(profile.requiredTools.includes('docintel_analyze'));
  assert.ok(profile.requiredTools.includes('rag_retrieve'));
  assert.ok(!profile.requiredTools.includes('web_search'));
});

test('agentic execution profile: explicit external research with files keeps web gate', () => {
  const profile = buildExecutionProfile({
    goal: 'Resume el documento adjunto y busca fuentes externas recientes en la web.',
    fileIds: ['file_docx'],
    fileMetadata: [{ id: 'file_docx', mimeType: 'application/pdf', name: 'informe.pdf' }],
  });

  assert.equal(profile.capabilities.needsPrivateContext, true);
  assert.equal(profile.capabilities.needsResearch, true);
  assert.ok(profile.requiredTools.includes('web_search'));
});

test('agentic execution profile: plain transcription does not force document generation', () => {
  const profile = buildExecutionProfile({
    goal: 'transcribir este archivo',
    fileIds: ['file_1'],
  });

  assert.equal(profile.capabilities.plainTranscription, true);
  assert.equal(profile.capabilities.needsPrivateContext, true);
  assert.equal(profile.capabilities.needsDocument, false);
  assert.ok(profile.requiredTools.includes('docintel_analyze'));
  assert.ok(profile.requiredTools.includes('rag_retrieve'));
  assert.ok(!profile.requiredTools.includes('create_document'));
  assert.ok(!profile.requiredTools.includes('verify_artifact'));
});

test('agentic execution profile: video generation requires generate_video, not document gates', () => {
  const profile = buildExecutionProfile({ goal: 'crea un video' });

  assert.equal(profile.capabilities.needsMedia, true);
  assert.equal(profile.capabilities.mediaKind, 'video');
  assert.equal(profile.capabilities.needsDocument, false);
  assert.ok(profile.requiredTools.includes('generate_video'));
  assert.ok(!profile.requiredTools.includes('create_document'));
  assert.ok(!profile.requiredTools.includes('verify_artifact'));

  const blocked = validateFinalize(profile, [
    { actions: [{ tool: 'finalize', observation: { answer: 'Listo.' } }] },
  ]);
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.missingTools, ['generate_video']);

  const allowed = validateFinalize(profile, [
    { actions: [{ tool: 'generate_video', observation: { ok: true, downloadUrl: '/video.mp4' } }] },
  ]);
  assert.equal(allowed.ok, true);
});

test('agentic execution profile: video ideation does not require generate_video', () => {
  const profile = buildExecutionProfile({ goal: 'necesito ideas para un video' });

  assert.equal(profile.capabilities.needsMedia, false);
  assert.ok(!profile.requiredTools.includes('generate_video'));
});

test('agentic execution profile: blocks finalize until required tools have succeeded', () => {
  const profile = buildExecutionProfile({
    goal: 'Investiga fuentes y crea un Word validado',
  });

  const blocked = validateFinalize(profile, [
    { actions: [{ tool: 'web_search', observation: { ok: true } }] },
  ]);
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.requiredTools, ['web_search', 'create_document', 'verify_artifact']);
  assert.deepEqual(blocked.missingTools, ['create_document', 'verify_artifact']);

  const allowed = validateFinalize(profile, [
    { actions: [{ tool: 'web_search', observation: { ok: true } }] },
    { actions: [{ tool: 'create_document', observation: { ok: true, artifactId: 'a1' } }] },
    { actions: [{ tool: 'verify_artifact', observation: { ok: true, validation: { passed: true } } }] },
  ]);
  assert.equal(allowed.ok, true);
});

test('agentic execution profile: OpenClaw autonomous software fusion requires code verification gates', () => {
  const profile = buildExecutionProfile({
    goal: 'Quiero que mejores el sofware copiando ideas de https://github.com/openclaw/openclaw/tree/v2026.5.28 y fusionarlo como agente autonomo',
  });

  assert.equal(profile.capabilities.needsCodeOrRepair, true);
  assert.equal(profile.capabilities.needsExternalRepoAdaptation, true);
  assert.equal(profile.capabilities.needsAutonomousSoftware, true);
  assert.ok(profile.requiredTools.includes('run_tests'));
  assert.ok(profile.qualityGates.some((gate) => /external repository capabilities/i.test(gate)));
  assert.ok(profile.qualityGates.some((gate) => /plan-execute-verify/i.test(gate)));
});

test('agentic execution profile: agent-runtime improvement requests trigger hardening gates', () => {
  const profile = buildExecutionProfile({
    goal: 'Sigamos mejorando los agentes del sofware para que trabajen de manera autonoma',
  });

  assert.equal(profile.capabilities.needsAgentRuntimeHardening, true);
  assert.equal(profile.capabilities.needsCodeOrRepair, true);
  assert.ok(profile.requiredTools.includes('run_tests'));
  assert.ok(profile.qualityGates.some((gate) => /agent runtime contracts/i.test(gate)));
});

test('agentic execution profile: bulk source fusion requires inventory before activation', () => {
  const profile = buildExecutionProfile({
    goal: 'Son millones de lineas de codigo que tenemos que copiar y fusionar desde OpenClaw',
  });

  assert.equal(profile.capabilities.needsBulkSourceFusion, true);
  assert.equal(profile.capabilities.needsCodeOrRepair, true);
  assert.ok(profile.requiredTools.includes('run_tests'));
  assert.ok(profile.qualityGates.some((gate) => /Inventory, attribute and rank bulk source/.test(gate)));
});

test('agentic execution profile: ordinary code copy does not require bulk source fusion', () => {
  const profile = buildExecutionProfile({
    goal: 'Copia este fragmento de codigo en la respuesta y explicalo breve',
  });

  assert.equal(profile.capabilities.needsCodeOrRepair, true);
  assert.equal(profile.capabilities.needsBulkSourceFusion, false);
  assert.ok(profile.requiredTools.includes('run_tests'));
  assert.equal(profile.qualityGates.some((gate) => /bulk source/i.test(gate)), false);
});

test('classifyAttachmentKinds: separates images from documents by mime and extension', () => {
  const kinds = classifyAttachmentKinds([
    { id: 'a', mimeType: 'image/png' },
    { id: 'b', name: 'photo.jpg' },
    { id: 'c', mimeType: 'application/pdf' },
    { id: 'd', type: 'image/webp' },
  ]);
  assert.equal(kinds.imageCount, 3);
  assert.equal(kinds.documentCount, 1);
  assert.equal(kinds.total, 4);
});

test('agentic execution profile: image-only attachment does NOT force the document-intelligence gate', () => {
  // The reported bug: a photo of a math problem + "resolver" in a thread that
  // earlier had a document was force-routed through docintel_retrieve, which
  // failed 5 times and dead-ended. Image attachments are vision content and
  // must not require docintel_analyze/rag_retrieve.
  const profile = buildExecutionProfile({
    goal: 'resolver',
    fileIds: ['file_img'],
    fileMetadata: [{ id: 'file_img', mimeType: 'image/png', name: 'math.png' }],
  });

  assert.equal(profile.capabilities.needsPrivateContext, false);
  assert.ok(!profile.requiredTools.includes('docintel_analyze'));
  assert.ok(!profile.requiredTools.includes('rag_retrieve'));

  // With no document gate, a plain finalize is allowed (vision answers it).
  const allowed = validateFinalize(profile, [
    { actions: [{ tool: 'finalize', observation: { answer: '10.375' } }] },
  ]);
  assert.equal(allowed.ok, true);
});

test('agentic execution profile: document attachment still forces docintel + rag (no regression)', () => {
  const profile = buildExecutionProfile({
    goal: 'resume esto',
    fileIds: ['file_doc'],
    fileMetadata: [{ id: 'file_doc', mimeType: 'application/pdf', name: 'tesis.pdf' }],
  });
  assert.equal(profile.capabilities.needsPrivateContext, true);
  assert.ok(profile.requiredTools.includes('docintel_analyze'));
  assert.ok(profile.requiredTools.includes('rag_retrieve'));
});

test('agentic execution profile: image + explicit private-file wording keeps the gate (photo of a doc)', () => {
  const profile = buildExecutionProfile({
    goal: 'segun el documento adjunto, que dice el primer parrafo',
    fileIds: ['file_img'],
    fileMetadata: [{ id: 'file_img', mimeType: 'image/jpeg', name: 'scan.jpg' }],
  });
  assert.equal(profile.capabilities.needsPrivateContext, true);
  assert.ok(profile.requiredTools.includes('docintel_analyze'));
});

test('agentic execution profile: missing metadata preserves legacy hasFiles behaviour', () => {
  const profile = buildExecutionProfile({ goal: 'resolver', fileIds: ['file_x'] });
  assert.equal(profile.capabilities.needsPrivateContext, true);
  assert.ok(profile.requiredTools.includes('docintel_analyze'));
});

test('validateFinalize: waives a required tool that the agent declared unavailable', () => {
  const profile = buildExecutionProfile({
    goal: 'resume este documento cargado',
    fileIds: ['file_1'],
  });
  assert.ok(profile.requiredTools.includes('docintel_analyze'));

  // No tools succeeded, but docintel_analyze is unavailable (exhausted its
  // error budget in the agent loop) → it must be waived so finalize is allowed
  // instead of dead-ending the task.
  const result = validateFinalize(profile, [], {
    unavailableTools: ['docintel_analyze', 'rag_retrieve'],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.waivedTools.sort(), ['docintel_analyze', 'rag_retrieve']);
});

test('validateFinalize: still blocks when a non-waived required tool is missing', () => {
  const profile = buildExecutionProfile({
    goal: 'resume este documento cargado',
    fileIds: ['file_1'],
  });
  const result = validateFinalize(profile, [], { unavailableTools: ['docintel_analyze'] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingTools, ['rag_retrieve']);
  assert.deepEqual(result.waivedTools, ['docintel_analyze']);
});

test('agentic execution profile: prompt exposes deterministic gates without user-specific content leakage', () => {
  const profile = buildExecutionProfile({ goal: 'Calcula Cronbach con esta tabla' });
  const prompt = buildExecutionProfilePrompt(profile);

  assert.match(prompt, /Required tools before finalize/);
  assert.match(prompt, /python_exec/);
  assert.doesNotMatch(prompt, /Calcula Cronbach/);
});
