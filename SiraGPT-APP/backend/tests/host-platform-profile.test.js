'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSafeAppAliases,
  buildSafeProjectAliases,
  inferProjectRootFromCwd,
  normalizeHostPlatform,
  resolveHostPlatformCapabilities,
} = require('../src/services/host-platform-profile');

test('host platform profile normalizes common OS names', () => {
  assert.equal(normalizeHostPlatform('darwin'), 'macos');
  assert.equal(normalizeHostPlatform('macOS'), 'macos');
  assert.equal(normalizeHostPlatform('linux'), 'linux');
  assert.equal(normalizeHostPlatform('ubuntu'), 'linux');
  assert.equal(normalizeHostPlatform('win32'), 'windows');
});

test('Linux profile exposes safe desktop launchers', () => {
  const apps = buildSafeAppAliases('linux');
  const terminal = apps.find((app) => app.app === 'Terminal');
  const firefox = apps.find((app) => app.app === 'Firefox');

  assert.ok(terminal);
  assert.equal(terminal.launcher.kind, 'linux_command');
  assert.equal(terminal.launcher.command, 'x-terminal-emulator');
  assert.ok(firefox);
});

test('Linux capabilities report supported bridge metadata', () => {
  const caps = resolveHostPlatformCapabilities({ SIRAGPT_DESKTOP_BRIDGE_PLATFORM: 'linux' });

  assert.equal(caps.platform, 'linux');
  assert.equal(caps.supported, true);
  assert.equal(caps.bridgeMode, 'local_linux_bridge');
  assert.equal(caps.shell, '/bin/sh');
  assert.ok(caps.openStrategies.includes('xdg-open'));
  assert.ok(caps.safeDiagnostics.includes('systemctl status'));
});

test('project aliases allow Linux root override', () => {
  const [project] = buildSafeProjectAliases({ SIRAGPT_PROJECT_ROOT: '/workspace/siraGPT' }, 'linux');

  assert.equal(project.id, 'siragpt');
  assert.equal(project.path, '/workspace/siraGPT');
  assert.ok(project.aliases.includes('siragpt'));
});

test('project root inference strips backend/test subdirectories in CI', () => {
  assert.equal(
    inferProjectRootFromCwd('/home/runner/work/siraGPT/siraGPT/backend'),
    '/home/runner/work/siraGPT/siraGPT',
  );
  assert.equal(
    inferProjectRootFromCwd('/Users/luis/Desktop/siraGPT/backend/tests'),
    '/Users/luis/Desktop/siraGPT',
  );
});
