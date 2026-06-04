'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const { planDesktopAction, resolveDesktopBridgeCapabilities } = require('./desktop-action-policy');
const { findSafeApp, normalizeHostPlatform } = require('./host-platform-profile');

const execFileAsync = promisify(execFile);

function getPlatform() {
  return normalizeHostPlatform(process.env.SIRAGPT_DESKTOP_BRIDGE_PLATFORM || os.platform());
}

function isLinux() {
  return getPlatform() === 'linux';
}

function isMac() {
  return getPlatform() === 'macos';
}

function getBridgeStatus(env = process.env) {
  const capabilities = resolveDesktopBridgeCapabilities(env);
  const tokenConfigured = Boolean(env.SIRAGPT_DESKTOP_BRIDGE_TOKEN);

  return {
    ...capabilities,
    tokenConfigured,
    ready: Boolean(capabilities.enabled && tokenConfigured),
    reason: capabilities.enabled
      ? (tokenConfigured ? 'ready' : 'missing_pairing_token')
      : 'disabled',
  };
}

function assertBridgeReady(env = process.env) {
  const status = getBridgeStatus(env);
  if (!status.ready) {
    const err = new Error('Computadora requiere activar y emparejar el bridge local.');
    err.code = 'BRIDGE_NOT_READY';
    err.bridgeStatus = status;
    throw err;
  }
  return status;
}

function assertPairingToken(providedToken, env = process.env) {
  const expected = env.SIRAGPT_DESKTOP_BRIDGE_TOKEN;
  if (!expected || providedToken !== expected) {
    const err = new Error('Invalid desktop bridge pairing token');
    err.code = 'INVALID_BRIDGE_TOKEN';
    throw err;
  }
}

async function captureDesktopScreenshot() {
  const file = path.join(os.tmpdir(), `siragpt-desktop-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);

  const platform = getPlatform();

  try {
    if (platform === 'macos') {
      await execFileAsync('/usr/sbin/screencapture', ['-x', '-t', 'png', file], { timeout: 8000 });
    } else if (platform === 'linux') {
      // Linux: try common screenshot tools in order of preference
      const linuxCommands = [
        ['flameshot', ['full', '-p', file]],
        ['scrot', ['-z', file]],
        ['gnome-screenshot', ['-f', file]],
        ['import', ['-window', 'root', file]], // ImageMagick
        ['spectacle', ['-b', '-o', file]],
      ];

      let success = false;
      for (const [cmd, args] of linuxCommands) {
        try {
          await execFileAsync(cmd, args, { timeout: 10000 });
          success = true;
          break;
        } catch {
          // try next tool
        }
      }

      if (!success) {
        throw new Error('No Linux screenshot tool found. Install flameshot, scrot, gnome-screenshot or ImageMagick.');
      }
    } else {
      throw new Error(`Desktop screenshots not supported on platform: ${platform}`);
    }

    const data = await fs.readFile(file);
    return `data:image/png;base64,${data.toString('base64')}`;
  } finally {
    await fs.unlink(file).catch(() => {});
  }
}

async function executeLinuxAdvancedAction(action) {
  // Linux advanced desktop control using xdotool (install with: sudo apt install xdotool)
  if (!isLinux()) {
    throw new Error('Advanced desktop actions are only available on Linux');
  }

  try {
    switch (action.type) {
      case 'move_mouse':
        await execFileAsync('xdotool', ['mousemove', String(action.x || 0), String(action.y || 0)], { timeout: 5000 });
        return { ok: true, action };

      case 'click':
        await execFileAsync('xdotool', ['click', String(action.button || 1)], { timeout: 5000 });
        return { ok: true, action };

      case 'type_text':
        if (action.text) {
          await execFileAsync('xdotool', ['type', action.text], { timeout: 10000 });
        }
        return { ok: true, action };

      case 'key_press':
        if (action.key) {
          await execFileAsync('xdotool', ['key', action.key], { timeout: 5000 });
        }
        return { ok: true, action };

      case 'scroll':
        const direction = action.direction === 'up' ? '4' : '5';
        await execFileAsync('xdotool', ['click', direction], { timeout: 5000 });
        return { ok: true, action };

      default:
        throw new Error(`Unsupported Linux advanced action: ${action.type}`);
    }
  } catch (err) {
    if (err.message.includes('xdotool')) {
      throw new Error('xdotool not found. Install it with: sudo apt install xdotool (or equivalent for your distro)');
    }
    throw err;
  }
}

async function executeDesktopBridgeAction(action, options = {}) {
  const env = options.env || process.env;
  assertBridgeReady(env);
  assertPairingToken(options.pairingToken || env.SIRAGPT_DESKTOP_BRIDGE_TOKEN, env);

  if (!action || typeof action !== 'object') {
    throw new Error('Desktop bridge action is required');
  }

  const platform = getPlatform();
  const isLinuxPlatform = platform === 'linux';

  // Handle advanced Linux desktop actions
  if (isLinuxPlatform && ['move_mouse', 'click', 'type_text', 'key_press', 'scroll'].includes(action.type)) {
    return executeLinuxAdvancedAction(action);
  }

  switch (action.type) {
    case 'open_app':
      if (isLinuxPlatform) {
        const app = findSafeApp(action.app, 'linux');
        if (!app?.launcher) {
          throw new Error(`Unsupported Linux app action: ${action.app}`);
        }
        if (app.launcher.kind === 'linux_xdg_open') {
          const target = app.launcher.target === 'home' ? os.homedir() : app.launcher.target;
          await execFileAsync('xdg-open', [target], { timeout: 10000 });
        } else {
          await execFileAsync(app.launcher.command, app.launcher.args || [], { timeout: 10000 });
        }
      } else {
        await execFileAsync('/usr/bin/open', ['-a', action.app], { timeout: 10000 });
      }
      return { ok: true, action };

    case 'open_project': {
      if (isLinuxPlatform) {
        if (action.preferredApp === 'Visual Studio Code') {
          try {
            await execFileAsync('code', [action.path], { timeout: 10000 });
            return { ok: true, action };
          } catch {
            // Fall back to the desktop file manager when Code is unavailable.
          }
        }
        await execFileAsync('xdg-open', [action.path], { timeout: 10000 });
      } else {
        const args = action.preferredApp ? ['-a', action.preferredApp, action.path] : [action.path];
        await execFileAsync('/usr/bin/open', args, { timeout: 10000 });
      }
      return { ok: true, action };
    }

    case 'open_url':
      if (isLinuxPlatform) {
        await execFileAsync('xdg-open', [action.url], { timeout: 10000 });
      } else {
        await execFileAsync('/usr/bin/open', [action.url], { timeout: 10000 });
      }
      return { ok: true, action };

    case 'run_shell_command':
      if (!options.acknowledged) {
        const err = new Error('Shell command requires explicit confirmation');
        err.code = 'CONFIRMATION_REQUIRED';
        throw err;
      }
      const shell = isLinuxPlatform ? '/bin/sh' : '/bin/zsh';
      await execFileAsync(shell, ['-lc', action.command], {
        cwd: action.workingDirectory || process.cwd(),
        timeout: Number(options.timeoutMs || 30000),
      });
      return { ok: true, action };

    default:
      throw new Error(`Unsupported desktop bridge action: ${action.type}`);
  }
}

function planLocalComputerTask(task, options = {}) {
  return planDesktopAction(task, options);
}

/**
 * High-level entry point for the Computer Use engine.
 * Routes actions correctly depending on the host platform.
 * On Linux: prefers real desktop control via xdotool + xdg tools.
 * On macOS: uses existing macOS bridge.
 */
async function executeComputerAction(action, options = {}) {
  const platform = getPlatform();

  if (platform === 'linux') {
    // Linux: support both advanced desktop actions and basic bridge actions
    const advancedTypes = ['move_mouse', 'click', 'type_text', 'key_press', 'scroll'];
    if (advancedTypes.includes(action.type)) {
      return executeLinuxAdvancedAction(action);
    }
    // Fall through to normal bridge for open_app, open_url, run_shell_command, etc.
    return executeDesktopBridgeAction(action, options);
  }

  // Non-Linux platforms use the existing bridge
  return executeDesktopBridgeAction(action, options);
}

module.exports = {
  captureDesktopScreenshot,
  executeDesktopBridgeAction,
  executeComputerAction,
  getBridgeStatus,
  planLocalComputerTask,
  _internal: { getPlatform, isLinux, isMac },
};
