'use strict';

const os = require('node:os');
const path = require('node:path');

const HOST_PLATFORM_PROFILE_VERSION = 'host-platform-profile-2026-06';

const COMMON_PROJECT_ALIASES = Object.freeze([
  'siragpt',
  'sira gpt',
  'repo siragpt',
  'repositorio siragpt',
  'repositorio de github siragpt',
]);

const APP_PROFILES = Object.freeze({
  macos: [
    { app: 'Terminal', aliases: ['terminal', 'consola', 'shell', 'iterm', 'i term'], launcher: { kind: 'mac_open_app', app: 'Terminal' } },
    { app: 'Music', aliases: ['music', 'musica', 'música', 'apple music', 'aplicacion de musica', 'aplicación de música'], launcher: { kind: 'mac_open_app', app: 'Music' } },
    { app: 'Finder', aliases: ['finder', 'archivos', 'carpetas'], launcher: { kind: 'mac_open_app', app: 'Finder' } },
    { app: 'Safari', aliases: ['safari', 'navegador safari'], launcher: { kind: 'mac_open_app', app: 'Safari' } },
    { app: 'Google Chrome', aliases: ['chrome', 'google chrome'], launcher: { kind: 'mac_open_app', app: 'Google Chrome' } },
    { app: 'Visual Studio Code', aliases: ['visual studio code', 'vscode', 'vs code', 'code editor'], launcher: { kind: 'mac_open_app', app: 'Visual Studio Code' } },
  ],
  linux: [
    { app: 'Terminal', aliases: ['terminal', 'consola', 'shell', 'xterm', 'gnome terminal', 'konsole'], launcher: { kind: 'linux_command', command: 'x-terminal-emulator', args: [] } },
    { app: 'Files', aliases: ['files', 'archivos', 'carpetas', 'nautilus', 'file manager'], launcher: { kind: 'linux_xdg_open', target: 'home' } },
    { app: 'Firefox', aliases: ['firefox', 'mozilla firefox'], launcher: { kind: 'linux_command', command: 'firefox', args: [] } },
    { app: 'Google Chrome', aliases: ['chrome', 'google chrome', 'chromium'], launcher: { kind: 'linux_command', command: 'google-chrome', args: [] } },
    { app: 'Visual Studio Code', aliases: ['visual studio code', 'vscode', 'vs code', 'code editor', 'code'], launcher: { kind: 'linux_command', command: 'code', args: [] } },
  ],
});

function normalizeHostPlatform(platform = os.platform()) {
  const value = String(platform || '').toLowerCase();
  if (value === 'darwin' || value === 'mac' || value === 'macos') return 'macos';
  if (value === 'linux' || value === 'ubuntu' || value === 'debian') return 'linux';
  if (value === 'win32' || value === 'windows') return 'windows';
  return 'unsupported';
}

function inferProjectRootFromCwd(cwd = process.cwd()) {
  const resolved = path.resolve(String(cwd || ''));
  const parts = resolved.split(path.sep);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i].toLowerCase() === 'siragpt') {
      return parts.slice(0, i + 1).join(path.sep) || path.sep;
    }
  }
  return null;
}

function resolveProjectPath(env = process.env, cwd = process.cwd()) {
  return env.SIRAGPT_PROJECT_ROOT
    || env.SIRAGPT_WORKSPACE_ROOT
    || inferProjectRootFromCwd(cwd)
    || path.join(os.homedir(), 'Desktop', 'siraGPT');
}

function buildSafeAppAliases(platform = os.platform()) {
  const normalized = normalizeHostPlatform(platform);
  const selected = APP_PROFILES[normalized] || APP_PROFILES.macos;
  return selected.map((profile) => ({ ...profile, aliases: [...profile.aliases] }));
}

function buildSafeProjectAliases(env = process.env, platform = os.platform()) {
  return [
    {
      id: 'siragpt',
      label: 'siraGPT',
      path: resolveProjectPath(env),
      aliases: COMMON_PROJECT_ALIASES,
      preferredApp: normalizeHostPlatform(platform) === 'linux' ? 'Visual Studio Code' : 'Visual Studio Code',
    },
  ];
}

function resolveHostPlatformCapabilities(env = process.env, opts = {}) {
  const platform = normalizeHostPlatform(env.SIRAGPT_DESKTOP_BRIDGE_PLATFORM || opts.platform || os.platform());
  const supported = platform === 'macos' || platform === 'linux';
  const bridgeMode = supported ? `local_${platform}_bridge` : 'unsupported_host_bridge';
  return {
    version: HOST_PLATFORM_PROFILE_VERSION,
    platform,
    supported,
    bridgeMode,
    openStrategies: platform === 'linux'
      ? ['xdg-open', 'x-terminal-emulator', 'desktop-file-command']
      : platform === 'macos'
        ? ['open', 'open -a', 'screencapture']
        : [],
    shell: platform === 'linux' ? '/bin/sh' : platform === 'macos' ? '/bin/zsh' : null,
    safeDiagnostics: platform === 'linux'
      ? ['uname', 'lsb_release', 'hostname', 'whoami', 'id', 'uptime', 'free', 'df', 'systemctl status']
      : ['uname', 'sw_vers', 'hostname', 'whoami', 'id', 'uptime', 'df'],
  };
}

function findSafeApp(appName, platform = os.platform()) {
  const normalizedName = String(appName || '').toLowerCase();
  return buildSafeAppAliases(platform).find((profile) => profile.app.toLowerCase() === normalizedName) || null;
}

module.exports = {
  HOST_PLATFORM_PROFILE_VERSION,
  normalizeHostPlatform,
  resolveHostPlatformCapabilities,
  buildSafeAppAliases,
  buildSafeProjectAliases,
  findSafeApp,
  resolveProjectPath,
  inferProjectRootFromCwd,
};
