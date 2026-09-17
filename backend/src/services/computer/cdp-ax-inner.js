'use strict';

const http = require('http');
const net = require('net');
const crypto = require('crypto');

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 9222, path }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    }).on('error', reject);
  });
}

function wsConnect(path) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(9222, '127.0.0.1');
    const pending = new Map();
    let buf = Buffer.alloc(0);
    let upgraded = false;
    sock.on('connect', () => {
      sock.write(
        'GET ' + path + ' HTTP/1.1\r\n' +
        'Host: 127.0.0.1:9222\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    function send(obj) {
      const payload = Buffer.from(JSON.stringify(obj));
      const mask = crypto.randomBytes(4);
      const masked = Buffer.from(payload);
      for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
      let hdr;
      if (payload.length < 126) {
        hdr = Buffer.alloc(6);
        hdr[0] = 0x81;
        hdr[1] = 0x80 | payload.length;
        mask.copy(hdr, 2);
      } else {
        hdr = Buffer.alloc(8);
        hdr[0] = 0x81;
        hdr[1] = 0x80 | 126;
        hdr.writeUInt16BE(payload.length, 2);
        mask.copy(hdr, 4);
      }
      sock.write(Buffer.concat([hdr, masked]));
    }
    function call(id, method, params) {
      return new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error('cdp_timeout ' + method)), 15000);
        pending.set(id, (err, result) => {
          clearTimeout(timer);
          if (err) rej(err);
          else res(result);
        });
        send({ id, method, params: params || {} });
      });
    }
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buf.slice(0, idx).toString();
        buf = buf.slice(idx + 4);
        if (!/ 101 /.test(head)) {
          reject(new Error('ws_upgrade ' + head.split('\r\n')[0]));
          sock.end();
          return;
        }
        upgraded = true;
        resolve({ call, close: () => sock.end() });
      }
      while (buf.length >= 2) {
        const fin = buf[0] & 0x80;
        const opcode = buf[0] & 0x0f;
        const masked = buf[1] & 0x80;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) break;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) break;
          const high = buf.readUInt32BE(2);
          const low = buf.readUInt32BE(6);
          if (high !== 0 || low > 8 * 1024 * 1024) break;
          len = low;
          off = 10;
        }
        if (masked) off += 4;
        if (buf.length < off + len) break;
        let payload = buf.slice(off, off + len);
        if (masked) {
          const mask = buf.slice(off - 4, off);
          payload = Buffer.from(payload);
          for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
        }
        buf = buf.slice(off + len);
        if (opcode === 9) {
          // ignore ping
          continue;
        }
        if (opcode === 1 || opcode === 2 || opcode === 0) {
          if (!sock._frag) sock._frag = [];
          sock._frag.push(payload);
          if (!fin) continue;
          const text = Buffer.concat(sock._frag).toString();
          sock._frag = [];
          try {
            const msg = JSON.parse(text);
            if (msg.id && pending.has(msg.id)) {
              const cb = pending.get(msg.id);
              pending.delete(msg.id);
              cb(msg.error ? new Error(msg.error.message) : null, msg.result);
            }
          } catch (_) { /* ignore */ }
        }
      }
    });
    sock.on('error', reject);
  });
}

function axStr(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object') return axStr(v.value);
  return '';
}
function flatten(nodes) {
  const lines = [];
  const byId = new Map((nodes || []).map((n) => [String(n.nodeId), n]));
  const kids = new Set();
  for (const n of nodes || []) for (const id of n.childIds || []) kids.add(String(id));
  const roots = (nodes || []).filter((n) => !kids.has(String(n.nodeId)));
  const walk = (n, depth) => {
    if (!n) return;
    const role = axStr(n.role) || 'unknown';
    const name = axStr(n.name);
    if (role === 'none' && !name) {
      for (const id of n.childIds || []) walk(byId.get(String(id)), depth);
      return;
    }
    lines.push('  '.repeat(Math.min(depth, 16)) + role + (name ? ' "' + name.slice(0, 80) + '"' : ''));
    for (const id of n.childIds || []) walk(byId.get(String(id)), depth + 1);
  };
  for (const root of (roots.length ? roots : (nodes || []).slice(0, 1))) walk(root, 0);
  return lines;
}

(async () => {
  const listed = await getJson('/json');
  const pages = Array.isArray(listed) ? listed : [];
  const page = pages.find((p) => p && p.type === 'page' && p.webSocketDebuggerUrl) || pages[0];
  if (!page || !page.webSocketDebuggerUrl) {
    process.stdout.write(JSON.stringify({ text: '(no page)', url: null, title: '' }));
    return;
  }
  const path = new URL(page.webSocketDebuggerUrl).pathname;
  const { call, close } = await wsConnect(path);
  try {
    await call(1, 'Accessibility.enable').catch(() => ({}));
    const tree = await call(2, 'Accessibility.getFullAXTree').catch(() => ({ nodes: [] }));
    const lines = flatten(tree.nodes || []);
    process.stdout.write(JSON.stringify({
      url: page.url || null,
      title: page.title || '',
      text: ['url: ' + (page.url || ''), 'title: ' + (page.title || ''), ...lines].join('\n').slice(0, 24000),
    }));
  } finally {
    close();
  }
})().catch((err) => {
  process.stderr.write(String(err && err.message || err));
  process.exit(2);
});
