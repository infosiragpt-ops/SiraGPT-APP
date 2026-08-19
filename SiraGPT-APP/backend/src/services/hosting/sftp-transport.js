'use strict';

/**
 * hosting/sftp-transport — upload a local directory to a remote host over SFTP
 * using `ssh2-sftp-client`. The Client class is injectable (DIP) so the upload
 * sequence can be unit-tested with a mock (no network).
 */

const path = require('path');
const { normalizeRemoteDir } = require('./remote-path');

function connectConfig(cfg) {
  return {
    host: cfg.host,
    port: Number(cfg.port) || 22,
    username: cfg.username,
    ...(cfg.privateKey ? { privateKey: cfg.privateKey, passphrase: cfg.passphrase || undefined } : {}),
    ...(cfg.password ? { password: cfg.password } : {}),
    readyTimeout: 20000,
  };
}

function getClient(deps) {
  const Client = (deps && deps.Client) || require('ssh2-sftp-client');
  return new Client();
}

/** Verify we can connect + see the remote base dir. */
async function testConnection(cfg, deps = {}) {
  const sftp = getClient(deps);
  try {
    await sftp.connect(connectConfig(cfg));
    return { ok: true };
  } finally {
    try {
      await sftp.end();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Upload localDir → remoteDir. When cleanSlate, the remote dir is wiped first.
 * onLog streams progress lines.
 */
/** Build an ssh2-sftp-client uploadDir filter from an exclude list (top-level
 *  names like node_modules / .git). Returns undefined when nothing to exclude. */
function buildFilter(local, exclude) {
  if (!Array.isArray(exclude) || exclude.length === 0) return undefined;
  const names = new Set(exclude);
  return (itemPath) => {
    const rel = path.relative(local, itemPath).split(path.sep);
    return !rel.some((seg) => names.has(seg));
  };
}

async function uploadDir(cfg, deps = {}) {
  const { localDir, remoteDir, cleanSlate, exclude, onLog = () => {} } = cfg;
  const remote = normalizeRemoteDir(remoteDir);
  const local = path.resolve(localDir);
  const sftp = getClient(deps);
  try {
    onLog(`[sftp] connecting to ${cfg.host}:${cfg.port || 22}…`);
    await sftp.connect(connectConfig(cfg));
    if (cleanSlate) {
      onLog(`[sftp] cleaning ${remote}`);
      try {
        await sftp.rmdir(remote, true);
      } catch {
        /* dir may not exist yet */
      }
    }
    onLog(`[sftp] ensuring ${remote}`);
    await sftp.mkdir(remote, true);
    onLog(`[sftp] uploading ${local} → ${remote}`);
    const filter = buildFilter(local, exclude);
    await sftp.uploadDir(local, remote, filter ? { filter } : undefined);
    onLog('[sftp] upload complete');
    return { ok: true, remoteDir: remote };
  } finally {
    try {
      await sftp.end();
    } catch {
      /* ignore */
    }
  }
}

module.exports = { uploadDir, testConnection, connectConfig };
