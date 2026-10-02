'use strict';

const http = require('http');
const net = require('net');

function joinPath(prefix, extra) {
  const left = String(prefix || '').replace(/\/$/, '');
  const right = String(extra || '');
  if (!right) return left || '/';
  return (left + (right.startsWith('/') ? right : `/${right}`)) || '/';
}

function isRefused(err) {
  const code = err && err.code;
  return code === 'ECONNREFUSED' || code === 'ECONNRESET';
}

function proxyHttp(req, res, { hostname, port, path, retries = 0, retryDelayMs = 200, openStream }) {
  let attempt = 0;
  const method = req.method;
  const replayable = method === 'GET' || method === 'HEAD';

  const tryOnce = () => {
    const headers = { ...req.headers, host: `${hostname}:${port}` };
    delete headers['content-length'];
    const controller = openStream ? new AbortController() : null;
    if (openStream) {
      delete headers.authorization;
      delete headers.cookie;
      headers.connection = 'close';
    }
    const upstream = http.request({
      hostname,
      port,
      path,
      method,
      headers,
      ...(openStream ? { createConnection: (_options, done) => {
        void openStream(controller.signal).then(stream => {
          if (controller.signal.aborted) { stream.destroy(); done(new Error('CDP connection unavailable')); }
          else done(null, stream);
        }, done);
      } } : {}),
    }, (pres) => {
      res.writeHead(pres.statusCode || 502, pres.headers);
      pres.pipe(res);
    });
    if (controller) {
      const stop = () => { controller.abort(); upstream.destroy(); };
      req.once('aborted', stop);
      res.once('close', stop);
    }
    upstream.on('error', (err) => {
      const canRetry = replayable
        && attempt < retries
        && !res.headersSent
        && isRefused(err);
      if (canRetry) {
        attempt += 1;
        setTimeout(tryOnce, retryDelayMs);
        return;
      }
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'proxy_failed', message: String(err && err.message || err) }));
    });
    if (replayable) {
      upstream.end();
    } else {
      req.pipe(upstream);
    }
  };
  tryOnce();
}

function proxyUpgrade(req, socket, head, { hostname, port, path, openStream }) {
  let target;
  const controller = openStream ? new AbortController() : null;
  const connected = stream => {
    target = stream;
    if (socket.destroyed) { stream.destroy(); return; }
    const lines = [
      `${req.method} ${path} HTTP/1.1`,
      `Host: ${hostname}:${port}`,
    ];
    for (const [name, value] of Object.entries(req.headers)) {
      const key = name.toLowerCase();
      if (key === 'host' || (openStream && (key === 'authorization' || key === 'cookie'))) continue;
      if (Array.isArray(value)) {
        for (const item of value) lines.push(`${name}: ${item}`);
      } else if (value != null) lines.push(`${name}: ${value}`);
    }
    lines.push('', '');
    stream.on('error', () => socket.destroy());
    stream.on('close', () => socket.destroy());
    stream.write(lines.join('\r\n'));
    if (head && head.length) stream.write(head);
    stream.pipe(socket);
    socket.pipe(stream);
  };
  const stop = () => { if (controller) controller.abort(); if (target) target.destroy(); };
  socket.on('error', stop);
  socket.on('close', stop);
  if (openStream) socket.on('end', () => { stop(); socket.destroy(); });
  if (openStream) {
    void openStream(controller.signal).then(connected, () => socket.destroy());
  } else {
    target = net.connect(port, hostname, () => connected(target));
    target.on('error', () => socket.destroy());
  }
}

module.exports = {
  joinPath,
  proxyHttp,
  proxyUpgrade,
};
