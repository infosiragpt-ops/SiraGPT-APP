'use strict';

/**
 * hosting/ftp-transport — upload a local directory over FTP/FTPS using
 * `basic-ftp` (pure JS; shared-hosting fallback when SSH/SFTP isn't available).
 * The ftp module is injectable (DIP) for unit tests.
 */

const path = require('path');
const { normalizeRemoteDir } = require('./remote-path');

function accessConfig(cfg) {
  return {
    host: cfg.host,
    port: Number(cfg.port) || 21,
    user: cfg.username,
    password: cfg.password || '',
    secure: cfg.protocol === 'ftps',
  };
}

function getClient(deps) {
  const ftp = (deps && deps.ftp) || require('basic-ftp');
  return new ftp.Client(30000);
}

async function testConnection(cfg, deps = {}) {
  const client = getClient(deps);
  try {
    await client.access(accessConfig(cfg));
    return { ok: true };
  } finally {
    client.close();
  }
}

async function uploadDir(cfg, deps = {}) {
  const { localDir, remoteDir, cleanSlate, onLog = () => {} } = cfg;
  const remote = normalizeRemoteDir(remoteDir);
  const local = path.resolve(localDir);
  const client = getClient(deps);
  try {
    onLog(`[ftp] connecting to ${cfg.host}:${cfg.port || 21}…`);
    await client.access(accessConfig(cfg));
    await client.ensureDir(remote);
    if (cleanSlate) {
      onLog(`[ftp] cleaning ${remote}`);
      try {
        await client.clearWorkingDir();
      } catch {
        /* ignore */
      }
    }
    onLog(`[ftp] uploading ${local} → ${remote}`);
    await client.uploadFromDir(local, remote);
    onLog('[ftp] upload complete');
    return { ok: true, remoteDir: remote };
  } finally {
    client.close();
  }
}

module.exports = { uploadDir, testConnection, accessConfig };
