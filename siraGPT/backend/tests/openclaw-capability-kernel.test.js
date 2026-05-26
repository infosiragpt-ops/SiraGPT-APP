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
