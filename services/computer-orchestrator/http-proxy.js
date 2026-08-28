'use strict';

const http = require('http');
const net = require('net');

function joinPath(prefix, extra) {
  const left = String(prefix || '').replace(/\/$/, '');
  const right = String(extra || '');
  if (!right) return left || '/';
  return (left + (right.startsWith('/') ? right : `/${right}`)) || '/';
}

function proxyHttp(req, res, { hostname, port, path }) {
  const headers = { ...req.headers, host: `${hostname}:${port}` };
  delete headers['content-length'];
  const upstream = http.request({
    hostname,
    port,
    path,
    method: req.method,
    headers,
  }, (pres) => {
    res.writeHead(pres.statusCode || 502, pres.headers);
    pres.pipe(res);
  });
  upstream.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'proxy_failed', message: String(err && err.message || err) }));
  });
  req.pipe(upstream);
}

function proxyUpgrade(req, socket, head, { hostname, port, path }) {
  const target = net.connect(port, hostname, () => {
    const lines = [
      `${req.method} ${path} HTTP/1.1`,
      `Host: ${hostname}:${port}`,
    ];
    for (const [name, value] of Object.entries(req.headers)) {
      if (name.toLowerCase() === 'host') continue;
      if (Array.isArray(value)) {
        for (const item of value) lines.push(`${name}: ${item}`);
      } else if (value != null) {
        lines.push(`${name}: ${value}`);
      }
    }
    lines.push('', '');
    target.write(lines.join('\r\n'));
    if (head && head.length) target.write(head);
    target.pipe(socket);
    socket.pipe(target);
  });
  target.on('error', () => {
    try { socket.destroy(); } catch (_) { /* ignore */ }
  });
  socket.on('error', () => {
    try { target.destroy(); } catch (_) { /* ignore */ }
  });
}

module.exports = {
  joinPath,
  proxyHttp,
  proxyUpgrade,
};
