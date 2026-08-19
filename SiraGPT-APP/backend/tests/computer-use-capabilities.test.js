'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_ACTIONS,
  DEFAULT_SAFETY_RULES,
  resolveComputerUseCapabilities,
} = require('../src/services/computer-use-capabilities');

test('computer-use capabilities describe an OpenClaw-style browser surface', () => {
  const caps = resolveComputerUseCapabilities({ OPENAI_API_KEY: 'sk-test' });

  assert.equal(caps.mode, 'openclaw_style_browser');
  assert.equal(caps.safety.requiresAuth, true);
  assert.equal(caps.safety.userScopedSessions, true);
  assert.equal(caps.safety.blocksExternalIrreversibleActions, true);
  assert.ok(caps.actions.includes('navigate'));
  assert.ok(caps.actions.includes('click'));
  assert.ok(caps.actions.includes('screenshot'));
  assert.ok(caps.limits.maxStepsPerTask > 0);
});

test('capabilities degrade planner status when OpenAI is not configured', () => {
  const caps = resolveComputerUseCapabilities({});
  assert.equal(caps.canPlanActions, false);
  assert.equal(caps.planner, 'manual_or_stub_only');
});

test('capabilities can be disabled through COMPUTER_USE_ENABLED=0', () => {
  const caps = resolveComputerUseCapabilities({
    OPENAI_API_KEY: 'sk-test',
    COMPUTER_USE_ENABLED: '0',
  });

  assert.equal(caps.enabled, false);
  assert.equal(caps.canLaunchBrowser, false);
  assert.equal(caps.canPlanActions, false);
});

test('exported defaults are stable enough for clients to render controls', () => {
  assert.ok(DEFAULT_ACTIONS.length >= 8);
  assert.ok(DEFAULT_ACTIONS.includes('extract_structured_data'));
  assert.ok(DEFAULT_SAFETY_RULES.some((rule) => /CAPTCHA/i.test(rule)));
});
