'use strict';

const http = require('node:http');
const { Duplex } = require('node:stream');

// This helper runs inside the already-owned desktop. No listener, shell,
// client-controlled command, profile or second Chrome process is created.
const CDP_BRIDGE_SCRIPT = String.raw`
const socket = require('node:net').connect({ host: '127.0.0.1', port: 9222 });
let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  process.stdin.unpipe(socket);
  process.stdin.destroy();
  socket.destroy();
  process.stdout.end(() => process.exit(code));
  setTimeout(() => process.exit(code), 1000).unref();
}
process.stdin.pipe(socket);
socket.pipe(process.stdout, { end: false });
socket.once('error', () => finish(1));
socket.once('end', () => finish(0));
process.stdin.once('end', () => finish(0));
process.stdin.once('error', () => finish(1));
process.stdout.once('error', () => finish(1));
`;

function unavailable() {
  const error = new Error('CDP connection unavailable');
  error.code = 'CDP_TRANSPORT_UNAVAILABLE';
  return error;
}

// Docker non-TTY exec multiplexes stdout/stderr with eight-byte headers.
// Stream stdout incrementally; never expose stderr or buffer entire CDP frames.
class ExecSocket extends Duplex {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this.header = Buffer.alloc(0);
    this.remaining = 0;
    this.channel = 0;
    socket.pause();
    if (head.length) socket.unshift(head);
    socket.on('data', bytes => {
      let offset = 0;
      while (offset < bytes.length && !this.destroyed) {
        if (this.remaining === 0) {
          const take = Math.min(8 - this.header.length, bytes.length - offset);
          this.header = Buffer.concat([this.header, bytes.subarray(offset, offset + take)]);
          offset += take;
          if (this.header.length < 8) break;
          this.channel = this.header[0];
          this.remaining = this.header.readUInt32BE(4);
          if (![1, 2].includes(this.channel) || this.header[1] || this.header[2] || this.header[3]
              || this.remaining > 16 * 1024 * 1024) { this.destroy(unavailable()); break; }
          this.header = Buffer.alloc(0);
          if (!this.remaining) continue;
        }
        const take = Math.min(this.remaining, bytes.length - offset);
        if (this.channel === 1 && !this.push(bytes.subarray(offset, offset + take))) socket.pause();
        offset += take;
        this.remaining -= take;
      }
    });
    socket.on('end', () => {
      if (this.remaining || this.header.length) this.destroy(unavailable());
      else this.push(null);
    });
    socket.on('error', () => this.destroy(unavailable()));
    socket.on('close', () => this.destroy());
    socket.on('timeout', () => this.emit('timeout'));
  }
  _read() { this.socket.resume(); }
  _write(bytes, encoding, done) { this.socket.write(bytes, encoding, done); }
  _final(done) { this.socket.end(done); }
  _destroy(error, done) { this.socket.destroy(); done(error); }
  setTimeout(ms, callback) { this.socket.setTimeout(ms); if (callback) this.once('timeout', callback); return this; }
  setNoDelay(value) { this.socket.setNoDelay(value); return this; }
  setKeepAlive(value, delay) { this.socket.setKeepAlive(value, delay); return this; }
  ref() { this.socket.ref(); return this; }
  unref() { this.socket.unref(); return this; }
}

function createExec(socketPath, apiVersion, container, signal) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({
      AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false,
      User: 'compuser', Cmd: ['node', '-e', CDP_BRIDGE_SCRIPT],
    }));
    const req = http.request({
      socketPath, path: `/${apiVersion}/containers/${encodeURIComponent(container)}/exec`, method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 65536) res.destroy(unavailable()); else chunks.push(chunk);
      });
      res.once('error', () => reject(unavailable()));
      res.once('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks));
          if (res.statusCode < 200 || res.statusCode >= 300 || !/^[a-f0-9]{64}$/i.test(value.Id)) throw unavailable();
          resolve(value.Id);
        } catch (_) { reject(unavailable()); }
      });
    });
    req.once('error', () => reject(unavailable()));
    req.end(body);
  });
}

function startExec(socketPath, apiVersion, id, signal) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ Detach: false, Tty: false }));
    const req = http.request({
      socketPath, path: `/${apiVersion}/exec/${id}/start`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, Connection: 'Upgrade', Upgrade: 'tcp' },
    });
    const abort = () => { req.destroy(unavailable()); reject(unavailable()); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    req.once('upgrade', (res, socket, head) => {
      cleanup();
      if (signal.aborted || res.statusCode !== 101) { socket.destroy(); reject(unavailable()); return; }
      resolve(new ExecSocket(socket, head));
    });
    req.once('response', res => { cleanup(); res.destroy(); reject(unavailable()); });
    req.once('error', () => { cleanup(); reject(unavailable()); });
    if (signal.aborted) abort(); else req.end(body);
  });
}

function createCdpConnector(env = process.env) {
  const socketPath = env.DOCKER_HOST_SOCKET || '/var/run/docker.sock';
  const rawVersion = String(env.DOCKER_API_VERSION || 'v1.44');
  const apiVersion = rawVersion.startsWith('v') ? rawVersion : `v${rawVersion}`;
  return async function openCdpSocket(container, signal) {
    // Container identity comes only from the authenticated session store.
    if (!/^sira-ac-user-[a-z0-9_-]+$/i.test(String(container || ''))) throw unavailable();
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000);
    bounded.throwIfAborted();
    const id = await createExec(socketPath, apiVersion, container, bounded);
    return startExec(socketPath, apiVersion, id, bounded);
  };
}

module.exports = { createCdpConnector };
