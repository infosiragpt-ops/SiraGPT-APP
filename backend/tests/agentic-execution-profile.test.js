const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildExecutionProfile,
  buildExecutionProfilePrompt,
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

test('agentic execution profile: prompt exposes deterministic gates without user-specific content leakage', () => {
  const profile = buildExecutionProfile({ goal: 'Calcula Cronbach con esta tabla' });
  const prompt = buildExecutionProfilePrompt(profile);

  assert.match(prompt, /Required tools before finalize/);
  assert.match(prompt, /python_exec/);
  assert.doesNotMatch(prompt, /Calcula Cronbach/);
});
