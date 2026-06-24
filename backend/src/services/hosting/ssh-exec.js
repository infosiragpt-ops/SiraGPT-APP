'use strict';

/**
 * hosting/ssh-exec — run a remote command over SSH (Phase 2: Node apps on a
 * VPS). Streams stdout/stderr via onLog and resolves with the exit code. The
 * ssh2 Client is injectable (DIP) for unit tests.
 */

function getClient(deps) {
  const { Client } = (deps && deps.ssh2) || require('ssh2');
  return new Client();
}

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

/**
 * Run `command` on the remote host. Resolves { code } (0 = success); rejects on
 * connection error. Streams output through onLog.
 */
function exec(cfg, command, { onLog = () => {}, timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const conn = getClient(cfg.__deps);
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      try {
        conn.end();
      } catch {
        /* ignore */
      }
      fn(arg);
    };
    const timer = setTimeout(() => finish(reject, new Error('SSH command timed out')), timeoutMs);

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          return finish(reject, err);
        }
        stream
          .on('close', (code) => {
            clearTimeout(timer);
            finish(resolve, { code: Number(code) || 0 });
          })
          .on('data', (d) => String(d).split('\n').forEach((l) => l.trim() && onLog(l.replace(/\s+$/, ''))))
          .stderr.on('data', (d) => String(d).split('\n').forEach((l) => l.trim() && onLog(l.replace(/\s+$/, ''))));
      });
    });
    conn.on('error', (err) => {
      clearTimeout(timer);
      finish(reject, err);
    });
    try {
      conn.connect(connectConfig(cfg));
    } catch (err) {
      clearTimeout(timer);
      finish(reject, err);
    }
  });
}

module.exports = { exec, connectConfig };
