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
function exec(cfg, command, { onLog = () => {}, timeoutMs = 10 * 60 * 1000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const conn = getClient(cfg.__deps);
    let settled = false;
    let stream = null;
    let timer = null;
    function onAbort() { finish(reject, new Error('SSH command cancelled')); }
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) { try { signal.removeEventListener?.('abort', onAbort); } catch { /* ignore */ } }
      if (fn === reject) {
        // Abandoning an in-flight command (timeout / cancel / error): best-effort
        // ask the remote to terminate it (some sshds honour signal forwarding),
        // then hard-tear-down — conn.end() alone is graceful and can leave a hung
        // remote command (e.g. `npm install`) running on the user's VPS.
        try { stream?.signal?.('KILL'); } catch { /* ignore */ }
        try { stream?.close?.(); } catch { /* ignore */ }
      }
      try { conn.end(); } catch { /* ignore */ }
      if (fn === reject) { try { conn.destroy?.(); } catch { /* ignore */ } }
      fn(arg);
    };
    if (signal) {
      if (signal.aborted) return finish(reject, new Error('SSH command cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => finish(reject, new Error('SSH command timed out')), timeoutMs);

    conn.on('ready', () => {
      conn.exec(command, (err, st) => {
        if (err) return finish(reject, err);
        stream = st;
        stream
          .on('close', (code) => finish(resolve, { code: Number(code) || 0 }))
          .on('data', (d) => String(d).split('\n').forEach((l) => l.trim() && onLog(l.replace(/\s+$/, ''))))
          .stderr.on('data', (d) => String(d).split('\n').forEach((l) => l.trim() && onLog(l.replace(/\s+$/, ''))));
      });
    });
    conn.on('error', (err) => finish(reject, err));
    try {
      conn.connect(connectConfig(cfg));
    } catch (err) {
      finish(reject, err);
    }
  });
}

module.exports = { exec, connectConfig };
