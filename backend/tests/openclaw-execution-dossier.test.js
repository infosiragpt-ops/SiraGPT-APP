'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const dossier = require('../src/services/openclaw-execution-dossier');
const kernel = require('../src/services/openclaw-capability-kernel');

test('scoreMode classifies repo work as software_agent', () => {
  const mode = dossier.scoreMode('Implementa mejoras en el backend, corre tests y haz deploy', {
    signals: { likelyLongRunning: true },
  });

  assert.equal(mode.primary, 'software_agent');
  assert.ok(mode.confidence >= 0.55);
});

test('buildExecutionDossier translates huge-code requests into durable architecture work', () => {
  const profile = kernel.buildCapabilityProfile({
    prompt: 'Quiero millones de lineas en el funcionamiento interno',
    toolNames: ['memory_recall', 'host_bash', 'host_file', 'run_tests', 'monitor_ci'],
  });

  const scalePacket = profile.executionDossier.workPackets.find((packet) => packet.id === 'scale');
  assert.ok(scalePacket);
  assert.match(scalePacket.doneWhen, /rather than artificial code volume/);
});

test('buildExecutionDossier selects coding and verification tools for software tasks', () => {
  const result = dossier.buildExecutionDossier({
    prompt: 'Arregla el bug del repo y corre los tests',
    profile: { signals: { likelyLongRunning: true } },
    toolNames: ['memory_recall', 'host_bash', 'host_file', 'run_tests', 'web_search'],
  });

  assert.equal(result.operatingMode.primary, 'software_agent');
  assert.ok(result.toolPlan.selected.includes('host_bash'));
  assert.ok(result.toolPlan.selected.includes('host_file'));
  assert.ok(result.toolPlan.selected.includes('run_tests'));
  assert.ok(result.qualityGates.includes('tests_or_typecheck_attempted'));
});

test('native repo adaptation adds no-copy work packets and gates', () => {
  const profile = kernel.buildCapabilityProfile({
    prompt: 'Integra OpenClaw sin copiar su codigo, reescribe todo en SiraGPT',
    toolNames: ['memory_recall', 'host_bash', 'host_file', 'run_tests'],
  });

  const packet = profile.executionDossier.workPackets.find((item) => item.id === 'native_adaptation');
  assert.ok(packet);
  assert.match(packet.doneWhen, /no active runtime import/);
  assert.ok(profile.executionDossier.qualityGates.includes('native_rewrite_no_verbatim_copy'));
  assert.ok(profile.executionDossier.riskControls.some((control) => control.risk === 'upstream_code_contamination'));
});

test('visual repair turns get attachment and repair gates', () => {
  const profile = kernel.buildCapabilityProfile({
    prompt: 'No entiende, regenera la respuesta de esta imagen',
    attachmentCount: 1,
    toolNames: ['memory_recall', 'docintel_analyze', 'verify_artifact'],
  });

  const d = profile.executionDossier;
  assert.ok(['repair_agent', 'document_intelligence'].includes(d.operatingMode.primary));
  assert.ok(d.workPackets.some((packet) => packet.id === 'repair'));
  assert.ok(d.qualityGates.includes('attachment_or_visual_evidence_checked'));
  assert.ok(d.qualityGates.includes('previous_mismatch_corrected'));
});

test('buildDossierPromptBlock produces prompt-ready operating instructions', () => {
  const result = dossier.buildExecutionDossier({
    prompt: 'Investiga este link y crea un informe',
    profile: { signals: {} },
    toolNames: ['web_search', 'read_url', 'create_document', 'verify_artifact'],
  });

  const block = dossier.buildDossierPromptBlock(result);
  assert.match(block, /OpenClaw Execution Dossier/);
  assert.match(block, /Operating mode:/);
  assert.match(block, /Work Packets/);
  assert.match(block, /Quality Gates/);
  assert.match(block, /web_search/);
});
