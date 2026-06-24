'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const kernel = require('../src/services/openclaw-capability-kernel');

test('classifyRequest detects repair turns and visual context', () => {
  const result = kernel.classifyRequest('No entiende, analiza la imagen y regenera', {
    attachmentCount: 1,
  });

  assert.equal(result.wantsRepair, true);
  assert.equal(result.referencesVisualContext, true);
  assert.equal(result.trustBoundary, 'mixed_user_and_attachment_context');
  assert.equal(result.plainVisionFallback, undefined);
});

test('buildCapabilityProfile exposes OpenClaw-level capabilities', () => {
  const profile = kernel.buildCapabilityProfile({
    prompt: 'Corrige este proyecto y haz deploy',
    userId: 'user-1',
    chatId: 'chat-1',
    recentTurnCount: 4,
    toolNames: ['web_search', 'memory_recall', 'run_tests'],
  });

  assert.equal(profile.version, 'openclaw-capability-kernel-2026-05');
  assert.equal(profile.capabilities.persistentMemory, true);
  assert.equal(profile.capabilities.toolUse, true);
  assert.equal(profile.capabilities.selfRepair, true);
  assert.equal(profile.signals.likelyLongRunning, true);
  assert.equal(profile.routing.shouldPreferAgentic, true);
  assert.deepEqual(profile.tools, ['web_search', 'memory_recall', 'run_tests']);
});

test('buildCapabilityProfile detects no-copy native repo adaptation requests', () => {
  const profile = kernel.buildCapabilityProfile({
    prompt: 'No copies el codigo de OpenClaw; reescribe e integra ese repositorio al funcionamiento de SiraGPT',
    toolNames: ['host_bash', 'host_file', 'run_tests'],
  });

  assert.equal(profile.signals.externalRepoAdaptation, true);
  assert.equal(profile.signals.nativeRewriteRequired, true);
  assert.equal(profile.capabilities.nativeRepoAdaptation, true);
  assert.equal(profile.routing.shouldPreferAgentic, true);

  const block = kernel.buildOpenClawPromptBlock(profile);
  assert.match(block, /Native Adaptation Contract/);
  assert.match(block, /do not copy active code/i);
});

test('buildCapabilityProfile detects OpenClaw copy-or-similar autonomous fusion requests', () => {
  const profile = kernel.buildCapabilityProfile({
    prompt: 'Mejora el sofware igual o similar a OpenClaw.ai, copia lo permitido y fusiona el repo para que funcione como agente autonomo',
    toolNames: ['memory_recall', 'host_bash', 'host_file', 'run_tests'],
  });

  assert.equal(profile.signals.externalRepoAdaptation, true);
  assert.equal(profile.signals.wantsAutonomousAgent, true);
  assert.equal(profile.signals.likelyLongRunning, true);
  assert.equal(profile.capabilities.autonomousExecution, true);
  assert.equal(profile.routing.shouldPreferAgentic, true);
  assert.ok(profile.executionDossier.qualityGates.includes('autonomous_plan_execute_verify_loop'));

  const block = kernel.buildOpenClawPromptBlock(profile);
  assert.match(block, /autonomous-agent software requests/i);
  assert.match(block, /wantsAutonomousAgent=true/);
});

test('buildCapabilityProfile detects million-line bulk source fusion requests', () => {
  const profile = kernel.buildCapabilityProfile({
    prompt: 'Continuar mejorando: son millones de lineas de codigo que tenemos que copiar y fusionar desde OpenClaw',
    toolNames: ['memory_recall', 'host_bash', 'host_file', 'run_tests'],
  });

  assert.equal(profile.signals.massiveSourceFusion, true);
  assert.equal(profile.signals.nativeRewriteRequired, true);
  assert.equal(profile.capabilities.bulkSourceFusion, true);
  assert.equal(profile.capabilities.nativeRepoAdaptation, true);
  assert.ok(profile.executionDossier.qualityGates.includes('bulk_source_inventory_completed'));
  assert.ok(profile.executionDossier.riskControls.some((control) => control.risk === 'mass_copy_bloat'));

  const block = kernel.buildOpenClawPromptBlock(profile);
  assert.match(block, /Bulk Source Fusion Contract/);
  assert.match(block, /staged source-ingestion program/);
  assert.match(block, /massiveSourceFusion=true/);
});

test('buildCapabilityProfile does not treat ordinary code copy wording as bulk fusion', () => {
  const profile = kernel.buildCapabilityProfile({
    prompt: 'Copia este fragmento de codigo en la respuesta y explicalo breve',
    toolNames: ['memory_recall'],
  });

  assert.equal(profile.signals.massiveSourceFusion, false);
  assert.equal(profile.signals.nativeRewriteRequired, false);
  assert.equal(profile.capabilities.bulkSourceFusion, false);
  assert.equal(profile.executionDossier.qualityGates.includes('bulk_source_inventory_completed'), false);
});

test('buildOpenClawRuntimeSummary emits compact durable runtime events', () => {
  const profile = kernel.buildCapabilityProfile({
    prompt: 'Fusiona OpenClaw con este software para que sea un agente autonomo avanzado',
    toolNames: ['memory_recall', 'host_bash', 'host_file', 'run_tests'],
  });

  const summary = kernel.buildOpenClawRuntimeSummary(profile);
  const events = kernel.buildOpenClawRuntimeEvents(profile);

  assert.equal(summary.signals.externalRepoAdaptation, true);
  assert.equal(summary.signals.wantsAutonomousAgent, true);
  assert.equal(summary.capabilities.autonomousExecution, true);
  assert.ok(summary.qualityGates.includes('autonomous_plan_execute_verify_loop'));
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'checkpoint');
  assert.equal(events[0].id, 'openclaw-runtime-profile');
  assert.equal(events[1].type, 'quality_gate');
  assert.equal(events[1].passed, true);
});

test('buildOpenClawRuntimeEvents skips ordinary long-running non-OpenClaw tasks', () => {
  const profile = kernel.buildCapabilityProfile({
    prompt: 'Investiga papers actuales y genera un reporte con fuentes',
    toolNames: ['web_search', 'memory_recall', 'run_tests'],
  });

  assert.equal(profile.signals.likelyLongRunning, true);
  assert.equal(profile.capabilities.autonomousExecution, true);
  assert.equal(profile.signals.externalRepoAdaptation, false);
  assert.equal(profile.signals.wantsAutonomousAgent, false);
  assert.deepEqual(kernel.buildOpenClawRuntimeEvents(profile), []);
});


test('buildCapabilityProfile does not treat ordinary repo refactors as external adaptation', () => {
  const profile = kernel.buildCapabilityProfile({
    prompt: 'Refactoriza este repo interno y corre los tests',
    toolNames: ['host_bash', 'host_file', 'run_tests'],
  });
  const styleOnly = kernel.buildCapabilityProfile({
    prompt: 'No copies el tono del ejemplo; responde breve',
    toolNames: ['memory_recall'],
  });

  assert.equal(profile.signals.externalRepoAdaptation, false);
  assert.equal(profile.signals.nativeRewriteRequired, false);
  assert.equal(profile.capabilities.nativeRepoAdaptation, false);
  assert.equal(profile.routing.shouldPreferAgentic, true);
  assert.equal(styleOnly.signals.nativeRewriteRequired, false);
  assert.equal(styleOnly.capabilities.nativeRepoAdaptation, false);
});

test('buildOpenClawPromptBlock includes runtime contracts and tool families', () => {
  const profile = kernel.buildCapabilityProfile({
    prompt: 'Regenera la respuesta con el PDF adjunto',
    attachmentCount: 1,
    toolNames: ['memory_recall', 'docintel_analyze', 'verify_artifact'],
    recentTurnCount: 3,
    memoryFacts: ['prefiere respuestas directas'],
  });
  const block = kernel.buildOpenClawPromptBlock(profile);

  assert.match(block, /OpenClaw-Level Runtime Policy/);
  assert.match(block, /Context Contract/);
  assert.match(block, /Capability Contract/);
  assert.match(block, /Repair Contract/);
  assert.match(block, /memory_recall, docintel_analyze, verify_artifact/);
  assert.match(block, /attachmentCount=1/);
  assert.match(block, /memoryFactCount=1/);
});
