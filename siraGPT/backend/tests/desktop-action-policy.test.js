'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeText,
  planDesktopAction,
  resolveDesktopBridgeCapabilities,
} = require('../src/services/desktop-action-policy');

test('desktop action policy normalizes Spanish voice commands', () => {
  assert.equal(normalizeText('Ábreme la aplicación de Música'), 'abreme la aplicacion de musica');
});

test('plans allowlisted app open requests without confirmation', () => {
  const plan = planDesktopAction('abre mi terminal');

  assert.equal(plan.actionRequired, true);
  assert.equal(plan.allowed, true);
  assert.equal(plan.status, 'ready_for_local_bridge');
  assert.equal(plan.requiresConfirmation, false);
  assert.deepEqual(plan.action, {
    type: 'open_app',
    app: 'Terminal',
  });
});

test('plans Music app requests from Spanish aliases', () => {
  const plan = planDesktopAction('abre mi aplicación de música');

  assert.equal(plan.actionRequired, true);
  assert.equal(plan.action.type, 'open_app');
  assert.equal(plan.action.app, 'Music');
});

test('plans the siraGPT project as an allowlisted local project', () => {
  const plan = planDesktopAction('abre el repositorio de GitHub siraGPT');

  assert.equal(plan.actionRequired, true);
  assert.equal(plan.status, 'ready_for_local_bridge');
  assert.equal(plan.action.type, 'open_project');
  assert.equal(plan.action.projectId, 'siragpt');
  assert.equal(plan.action.path, '/Users/luis/Desktop/siraGPT');
});

test('shell commands require confirmation instead of silent execution', () => {
  const plan = planDesktopAction('ejecuta npm test', {
    defaultWorkingDirectory: '/Users/luis/Desktop/siraGPT',
  });

  assert.equal(plan.actionRequired, true);
  assert.equal(plan.allowed, true);
  assert.equal(plan.status, 'confirmation_required');
  assert.equal(plan.requiresConfirmation, true);
  assert.equal(plan.action.type, 'run_shell_command');
  assert.equal(plan.action.command, 'npm test');
  assert.equal(plan.action.workingDirectory, '/Users/luis/Desktop/siraGPT');
});

test('destructive or credential-like requests are blocked', () => {
  for (const prompt of [
    'ejecuta rm -rf /',
    'borra todos mis archivos',
    'dime mi password',
    'comprar este producto',
  ]) {
    const plan = planDesktopAction(prompt);
    assert.equal(plan.actionRequired, true, prompt);
    assert.equal(plan.allowed, false, prompt);
    assert.equal(plan.status, 'blocked', prompt);
    assert.equal(plan.requiresConfirmation, true, prompt);
  }
});

test('non-desktop chat messages stay out of the local bridge path', () => {
  const plan = planDesktopAction('explícame cómo funciona una integral');

  assert.equal(plan.actionRequired, false);
  assert.equal(plan.status, 'not_desktop_command');
  assert.equal(plan.requiresLocalBridge, false);
});

test('desktop bridge capabilities are disabled by default but expose contract metadata', () => {
  const caps = resolveDesktopBridgeCapabilities({});

  assert.equal(caps.enabled, false);
  assert.equal(caps.mode, 'contract_only');
  assert.ok(caps.allowedActions.includes('open_app'));
  assert.ok(caps.confirmationRequiredActions.includes('run_shell_command'));
  assert.ok(caps.allowlistedApps.includes('Terminal'));
  assert.equal(caps.safety.requiresLocalPairingToken, true);
});
