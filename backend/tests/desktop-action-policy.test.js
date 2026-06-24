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
  assert.equal(plan.action.type, 'open_app');
  assert.equal(plan.action.app, 'Terminal');
  assert.equal(plan.action.platform, plan.hostPlatform);
});

test('plans Music app requests from Spanish aliases', () => {
  const plan = planDesktopAction('abre mi aplicación de música', { platform: 'macos' });

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
  assert.match(plan.action.path, /siraGPT$/);
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
  assert.ok(caps.hostPlatform);
  assert.equal(caps.safety.requiresLocalPairingToken, true);
});

test('desktop action policy plans Linux terminal actions explicitly', () => {
  const plan = planDesktopAction('abre la terminal', { platform: 'linux' });

  assert.equal(plan.actionRequired, true);
  assert.equal(plan.allowed, true);
  assert.equal(plan.hostPlatform, 'linux');
  assert.equal(plan.action.type, 'open_app');
  assert.equal(plan.action.app, 'Terminal');
  assert.equal(plan.action.platform, 'linux');
  assert.equal(plan.action.launcher.kind, 'linux_command');
  assert.equal(plan.action.launcher.command, 'x-terminal-emulator');
});

test('desktop bridge capabilities expose Linux bridge mode when requested', () => {
  const caps = resolveDesktopBridgeCapabilities({
    SIRAGPT_DESKTOP_BRIDGE_ENABLED: '1',
    SIRAGPT_DESKTOP_BRIDGE_PLATFORM: 'linux',
    SIRAGPT_PROJECT_ROOT: '/workspace/siraGPT',
  });

  assert.equal(caps.enabled, true);
  assert.equal(caps.mode, 'local_linux_bridge');
  assert.equal(caps.hostPlatform.platform, 'linux');
  assert.equal(caps.hostPlatform.supported, true);
  assert.ok(caps.hostPlatform.openStrategies.includes('xdg-open'));
  assert.ok(caps.allowlistedApps.includes('Firefox'));
  assert.deepEqual(caps.allowlistedProjects[0], {
    id: 'siragpt',
    label: 'siraGPT',
    path: '/workspace/siraGPT',
  });
});
