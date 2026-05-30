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
