'use strict';

/**
 * Session terminal channels — PTY stub over sandbox.exec.
 *
 * Not node-pty. Line-buffered interactive exec with jailed cwd,
 * injectable transport, and Spanish errors. Flag: AGENTES_CODING_V2.
 */

const crypto = require('node:crypto');
const { isAgentesCodingV2Enabled } = require('../flags');
const { fail, CodingSandboxError } = require('../coding-sandbox/errors');
const { jailRelPath } = require('../coding-sandbox/path-jail');
const { SIGNALS, decodeFrame } = require('./protocol');

const MAX_CHANNELS_PER_SESSION = 4;
const MAX_INPUT_BYTES = 64 * 1024;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

function newChannelId() {
  return `trm_${crypto.randomBytes(10).toString('hex')}`;
}

function jailCwd(cwd) {
  if (cwd == null || cwd === '' || cwd === '/workspace') return '.';
  return jailRelPath(cwd, { forList: true });
}

function clampSize(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function requireEnabled(env) {
  if (!isAgentesCodingV2Enabled(env)) fail('E_FLAG_OFF');
}

function createChannel(opts) {
  const {
    id,
    sessionId,
    sandbox,
    now,
  } = opts;
  let cwd = jailCwd(opts.cwd);
  let cols = clampSize(opts.cols, DEFAULT_COLS, 20, 400);
  let rows = clampSize(opts.rows, DEFAULT_ROWS, 5, 200);
  let inputBuf = '';
  let running = false;
  let closed = false;
  let lastExit = null;
  let abortController = null;
  const transports = new Set();
  const createdAt = now();

  function snapshot() {
    return {
      channelId: id,
      sessionId,
      cwd,
      cols,
      rows,
      running,
      closed,
      lastExit,
      createdAt,
    };
  }

  function broadcast(frame) {
    for (const transport of transports) {
      try { transport.send(frame); } catch (_) { /* ignore */ }
    }
  }

  function attach(transport) {
    if (closed) fail('E_PARAMS', 'El canal de terminal ya está cerrado.');
    if (!transport || typeof transport.send !== 'function') {
      fail('E_PARAMS', 'Falta el transporte del terminal.');
    }
    transports.add(transport);
    if (typeof transport.onMessage === 'function') {
      transport.onMessage((frame) => {
        void handleFrame(frame).catch((err) => {
          broadcast({
            type: 'error',
            error: err instanceof CodingSandboxError ? err.code : (err.code || 'E_TERMINAL_FAILED'),
            message: err.message || 'No se pudo abrir el canal de terminal.',
          });
        });
      });
    }
    transport.send({
      type: 'ready',
      channelId: id,
      sessionId,
      cwd,
      cols,
      rows,
    });
    return snapshot();
  }

  function detach(transport) {
    transports.delete(transport);
  }

  async function handleFrame(raw) {
    const frame = raw && raw.type ? raw : decodeFrame(raw);
    switch (frame.type) {
      case 'attach':
        return snapshot();
      case 'input':
        return receiveInput(frame.data);
      case 'resize':
        return resize(frame.cols, frame.rows);
      case 'exec':
        return runCommand(frame.command != null ? frame.command : inputBuf, {
          cwd: frame.cwd,
          timeoutMs: frame.timeoutMs,
        });
      case 'signal':
        return signal(frame.name || frame.signal);
      case 'close':
        return close();
      default:
        fail('E_PARAMS', 'Tipo de marco de terminal no soportado.');
    }
    return snapshot();
  }

  function receiveInput(data) {
    if (closed) fail('E_PARAMS', 'El canal de terminal ya está cerrado.');
    const chunk = String(data == null ? '' : data);
    if (Buffer.byteLength(inputBuf, 'utf8') + Buffer.byteLength(chunk, 'utf8') > MAX_INPUT_BYTES) {
      fail('E_QUOTA', 'La entrada del terminal supera el tope.');
    }
    inputBuf += chunk;
    const nl = inputBuf.indexOf('\n');
    if (nl === -1) return snapshot();
    const line = inputBuf.slice(0, nl).replace(/\r$/, '');
    inputBuf = inputBuf.slice(nl + 1);
    return runCommand(line);
  }

  function resize(nextCols, nextRows) {
    if (closed) fail('E_PARAMS', 'El canal de terminal ya está cerrado.');
    cols = clampSize(nextCols, cols, 20, 400);
    rows = clampSize(nextRows, rows, 5, 200);
    return snapshot();
  }

  async function runCommand(command, execOpts = {}) {
    if (closed) fail('E_PARAMS', 'El canal de terminal ya está cerrado.');
    const cmd = String(command || '').trim();
    if (!cmd) fail('E_PARAMS', 'Falta el comando.');
    if (running) fail('E_PARAMS', 'Ya hay un comando en ejecución.');
    if (execOpts.cwd != null && execOpts.cwd !== '') {
      cwd = jailCwd(execOpts.cwd);
    }
    running = true;
    abortController = typeof AbortController === 'function' ? new AbortController() : null;
    try {
      const result = await sandbox.exec(sessionId, cmd, {
        cwd,
        timeoutMs: execOpts.timeoutMs,
        signal: abortController ? abortController.signal : undefined,
      });
      if (result.stdout) broadcast({ type: 'stdout', data: String(result.stdout) });
      if (result.stderr) broadcast({ type: 'stderr', data: String(result.stderr) });
      lastExit = {
        exitCode: result.exitCode ?? (result.ok ? 0 : 1),
        timedOut: Boolean(result.timedOut),
        ok: Boolean(result.ok),
      };
      broadcast({ type: 'exit', ...lastExit });
      inputBuf = '';
      return snapshot();
    } catch (err) {
      if (err instanceof CodingSandboxError) {
        broadcast({ type: 'error', error: err.code, message: err.message });
        throw err;
      }
      fail('E_TERMINAL_FAILED', err && err.message ? String(err.message) : undefined);
    } finally {
      running = false;
      abortController = null;
    }
    return snapshot();
  }

  function signal(name) {
    const sig = String(name || '').toUpperCase();
    if (!SIGNALS.includes(sig)) fail('E_PARAMS', 'Señal de terminal no soportada.');
    if (abortController && typeof abortController.abort === 'function') {
      abortController.abort();
    }
    return snapshot();
  }

  function close() {
    if (closed) return snapshot();
    closed = true;
    if (abortController && typeof abortController.abort === 'function') {
      abortController.abort();
    }
    broadcast({ type: 'closed', channelId: id, sessionId });
    for (const transport of transports) {
      try { transport.close(); } catch (_) { /* ignore */ }
    }
    transports.clear();
    return snapshot();
  }

  return {
    id,
    sessionId,
    attach,
    detach,
    handleFrame,
    receiveInput,
    resize,
    runCommand,
    signal,
    close,
    snapshot,
    get closed() { return closed; },
  };
}

function createTerminalHub(opts = {}) {
  const env = opts.env || process.env;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const sandbox = opts.sandbox;
  const channels = new Map();
  const bySession = new Map();

  function getSandbox() {
    if (!sandbox || typeof sandbox.exec !== 'function') {
      fail('E_PARAMS', 'Falta el sandbox de la sesión.');
    }
    return sandbox;
  }

  function forget(channel) {
    channels.delete(channel.id);
    const set = bySession.get(channel.sessionId);
    if (set) {
      set.delete(channel.id);
      if (!set.size) bySession.delete(channel.sessionId);
    }
  }

  async function open(input = {}) {
    requireEnabled(env);
    const sessionId = String(input.sessionId || '').trim();
    if (!sessionId) fail('E_PARAMS', 'Falta sessionId.');
    const sb = getSandbox();
    if (typeof sb.getSession === 'function' && !sb.getSession(sessionId)) {
      fail('E_SESSION_NOT_FOUND');
    }
    const existing = bySession.get(sessionId) || new Set();
    if (existing.size >= MAX_CHANNELS_PER_SESSION) {
      fail('E_QUOTA', 'Tope de canales de terminal por sesión.');
    }
    const id = String(input.id || newChannelId());
    if (channels.has(id)) fail('E_PARAMS', 'channelId duplicado.');
    const channel = createChannel({
      id,
      sessionId,
      sandbox: sb,
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
      now,
    });
    channels.set(id, channel);
    existing.add(id);
    bySession.set(sessionId, existing);
    if (input.transport) channel.attach(input.transport);
    return channel.snapshot();
  }

  function get(channelId) {
    requireEnabled(env);
    const id = String(channelId || '').trim();
    if (!id) fail('E_PARAMS', 'Falta channelId.');
    const channel = channels.get(id);
    if (!channel || channel.closed) fail('E_SESSION_NOT_FOUND', 'El canal de terminal no existe.');
    return channel;
  }

  function close(channelId) {
    const channel = get(channelId);
    const snap = channel.close();
    forget(channel);
    return snap;
  }

  function closeSession(sessionId) {
    const id = String(sessionId || '').trim();
    const set = bySession.get(id);
    if (!set) return 0;
    let n = 0;
    for (const channelId of [...set]) {
      const channel = channels.get(channelId);
      if (channel) {
        channel.close();
        forget(channel);
        n += 1;
      }
    }
    return n;
  }

  return {
    open,
    get,
    close,
    closeSession,
    attach(channelId, transport) {
      return get(channelId).attach(transport);
    },
    handleFrame(channelId, frame) {
      return get(channelId).handleFrame(frame);
    },
    snapshot(channelId) {
      return get(channelId).snapshot();
    },
    size() {
      return channels.size;
    },
  };
}

module.exports = {
  createTerminalHub,
  createChannel,
  jailCwd,
  MAX_CHANNELS_PER_SESSION,
  MAX_INPUT_BYTES,
  DEFAULT_COLS,
  DEFAULT_ROWS,
};
