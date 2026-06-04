'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const { planDesktopAction, resolveDesktopBridgeCapabilities } = require('./desktop-action-policy');

const execFileAsync = promisify(execFile);

function getPlatform() {
  return os.platform();
}

function isLinux() {
  return getPlatform() === 'linux';
}

function isMac() {
  return getPlatform() === 'darwin';
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
    if (platform === 'darwin') {
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

async function executeDesktopBridgeAction(action, options = {}) {
  const env = options.env || process.env;
  assertBridgeReady(env);
  assertPairingToken(options.pairingToken || env.SIRAGPT_DESKTOP_BRIDGE_TOKEN, env);

  if (!action || typeof action !== 'object') {
    throw new Error('Desktop bridge action is required');
  }

  const platform = getPlatform();
  const isLinuxPlatform = platform === 'linux';

  switch (action.type) {
    case 'open_app':
      if (isLinuxPlatform) {
        // Linux: try gtk-launch first, then xdg-open as fallback
        try {
          await execFileAsync('gtk-launch', [action.app], { timeout: 10000 });
        } catch {
          await execFileAsync('xdg-open', [action.app], { timeout: 10000 });
        }
      } else {
        await execFileAsync('/usr/bin/open', ['-a', action.app], { timeout: 10000 });
      }
      return { ok: true, action };

    case 'open_project': {
      if (isLinuxPlatform) {
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
      const shell = isLinuxPlatform ? '/bin/bash' : '/bin/zsh';
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

module.exports = {
  captureDesktopScreenshot,
  executeDesktopBridgeAction,
  getBridgeStatus,
  planLocalComputerTask,
};
